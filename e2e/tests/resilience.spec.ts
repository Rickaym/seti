import { randomUUID } from 'node:crypto'
import type { MessagePage } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test } from './support/fixtures.js'
import { transcript } from './support/restart.js'
import { sse } from './support/transcript-loading.js'

const CRASH = /^Seti could not render /

test.use({ allowedConsoleErrors: [CRASH] })

const SLUG = 'e2e/resilience'

function pr(number: number, extra: Record<string, unknown> = {}) {
  return {
    key: `resilience-${String(number)}`,
    repo_id: SLUG,
    repo_slug: SLUG,
    number,
    title: `resilience change ${String(number)}`,
    url: `https://github.com/${SLUG}/pull/${String(number)}`,
    draft: false,
    author: 'e2e',
    head_ref: `feat/change-${String(number)}`,
    base_ref: 'main',
    head_oid: 'abc1234',
    updated_at: `2026-10-02T1${String(number)}:00:00Z`,
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: 'success',
    checks: [],
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
    ...extra,
  }
}

const MALFORMED = [pr(1, { preview: null, tasks: null, checks: [null], related: [{ url: 7 }] }), pr(2)]

test('a linked PR with a null preview leaves the agent header and the rest of the app usable', async ({ page }) => {
  const warnings: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'warning') {
      warnings.push(message.text())
    }
  })
  const id = randomUUID()
  const db = openSeedDb()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Resilient PRs', paths.checkout, at)
  for (const item of MALFORMED) {
    await db.run(`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES (?, ?, ?, 'user')`, id, item.url, at)
  }
  await db.close()
  await page.route(/\/api\/prs\/lookup$/, async (route) => {
    await route.fulfill({ json: { data: MALFORMED } })
  })
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')

  await expect(main.getByRole('group', { name: 'Pull request resilience#1' })).toBeVisible()
  await expect(main.getByRole('link', { name: 'resilience#2' })).toHaveAttribute('title', 'resilience change 2')
  await expect(main.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('contentinfo')).toBeVisible()
  expect(warnings.join('\n')).toMatch(/Seti repaired a malformed response from \/prs\/lookup: .*preview/)

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents' }).click()
  await expect(main.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await page.request.delete(`/api/tasks/${id}`)
})

test('one malformed transcript row shows as a note and the rest of the transcript renders', async ({
  page,
  request,
}) => {
  const id = randomUUID()
  const db = openSeedDb()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Malformed row agent', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Summarise the incident' }), at)
  const good = {
    type: 'assistant',
    uuid: 'good-row',
    session_id: 's',
    parent_tool_use_id: null,
    message: {
      id: 'm',
      type: 'message',
      role: 'assistant',
      model: 'claude',
      content: [{ type: 'text', text: 'All clear now.' }],
    },
  }
  await db.message(id, 'sdk', JSON.stringify(good), at)
  await db.close()

  const [prompt, reply] = (await apiData<MessagePage>(request, `/tasks/${id}/messages`)).messages
  if (prompt === undefined || reply === undefined) {
    throw new Error('seeded rows are missing')
  }
  const bad = { type: 'assistant', uuid: 'bad-row', session_id: 's', parent_tool_use_id: null, message: { content: 7 } }
  const malformedRow = { ...prompt, id: prompt.id + 0.5, kind: 'sdk', payload: bad }
  await page.route(new RegExp(`/api/tasks/${id}/stream`), async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: `retry: 60000\n\n${sse('backlog', { messages: [prompt, malformedRow, reply], has_older: false })}`,
    })
  })

  await page.goto(`/#agents/${id}`)
  const rows = transcript(page)
  await expect(rows).toContainText('Summarise the incident')
  await expect(rows).toContainText('All clear now.')
  const note = rows.getByRole('note')
  await expect(note).toContainText('This message could not be shown.')
  await note.getByText('This message could not be shown.').click()
  await expect(note.getByRole('button', { name: 'Copy details' })).toBeVisible()
  await expect(page.getByRole('main').getByRole('combobox', { name: 'Reply' })).toBeEditable()
})

test('a stored row that does not fit its kind reaches the transcript as a note, not a failed load', async ({
  page,
  request,
}) => {
  const id = randomUUID()
  const db = openSeedDb()
  const at = new Date().toISOString()
  await db.idleTask(id, 'Stored malformed row agent', paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Check the stored rows' }), at)
  const bad = { type: 'assistant', uuid: 'bad-row', session_id: 's', parent_tool_use_id: null, message: { content: 7 } }
  await db.message(id, 'sdk', JSON.stringify(bad), at)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Still here after the bad row' }), at)
  await db.close()

  const rows = (await apiData<MessagePage>(request, `/tasks/${id}/messages`)).messages
  expect(rows.map((row) => row.kind)).toEqual(['prompt', 'unreadable', 'prompt'])
  await page.goto(`/#agents/${id}`)
  const shown = transcript(page)
  await expect(shown).toContainText('Check the stored rows')
  await expect(shown).toContainText('Still here after the bad row')
  const note = shown.getByRole('note').filter({ hasText: 'This message could not be shown.' })
  await note.getByText('This message could not be shown.').click()
  await expect(note).toContainText('message.content')
})

test('a crashed section offers a reload and the rest of the app keeps working', async ({ page }) => {
  let broken = true
  await page.route(/\/api\/context\/packs$/, async (route) => {
    if (broken) {
      const pack = { id: 'p1', name: 'Broken', description: '', body: null, kind: 'reference', builtin: false }
      await route.fulfill({ json: { data: [pack] } })
    } else {
      await route.fallback()
    }
  })
  await page.goto('/#context')
  const main = page.getByRole('main')
  const alert = main.getByRole('alert')
  await expect(alert).toContainText('Context could not be shown.')
  await expect(alert).toContainText('The rest of Seti still works.')
  await expect(page.getByRole('contentinfo')).toBeVisible()

  broken = false
  await alert.getByRole('button', { name: 'Reload this panel' }).click()
  await expect(main.getByRole('alert')).toHaveCount(0)
  await expect(main.getByRole('heading', { name: 'Context', level: 1 })).toBeVisible()

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Agents' }).click()
  await expect(main.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
})
