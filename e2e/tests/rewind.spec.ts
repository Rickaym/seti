import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import type { CommandCatalog, Envelope } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, nextApiResponse, test } from './support/fixtures.js'

const SESSION = 'rewind-session'

const assistant = (text: string) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content: [{ type: 'text', text }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: randomUUID(),
})

const turnDone = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 2000,
  num_turns: 1,
  result: 'ok',
  total_cost_usd: 0.01,
  session_id: SESSION,
  uuid: randomUUID(),
}

/** A task written straight into the database with two answered prompts and a slash command. */
async function seedTask(status: 'idle' | 'running'): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, session_id, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, ?, ?, ?, ?)`,
    id,
    `Rewind ${status}`,
    paths.checkout,
    SESSION,
    status,
    ts,
    ts,
  )
  const rows: [string, unknown][] = [
    ['prompt', { text: 'Remember the code word PELICAN.' }],
    ['sdk', assistant('Noted: PELICAN.')],
    ['sdk', turnDone],
    ['prompt', { text: '/cost' }],
    ['prompt', { text: 'Also remember the color TEAL.' }],
    ['sdk', assistant('Noted: TEAL.')],
    ['sdk', turnDone],
  ]
  for (const [kind, payload] of rows) {
    await db.message(id, kind, JSON.stringify(payload), ts)
  }
  await db.close()
  return id
}

async function openTask(page: Page, taskId: string) {
  const catalog: CommandCatalog = {
    cwd: paths.checkout,
    probed_at: new Date().toISOString(),
    fresh: true,
    approximate: false,
    commands: [],
  }
  await page.route(/\/api\/tasks\/[^/]+\/commands$/, async (route) =>
    route.fulfill({ json: { data: catalog, meta: {} } satisfies Envelope<CommandCatalog> }),
  )
  await page.goto(`/#agents/${taskId}`)
  await expect(page.getByText('Noted: TEAL.')).toBeVisible()
}

const composerStatus = (page: Page) => page.getByRole('status', { name: 'Composer status' })

test('Esc stops a running turn once, unless a dialog takes it, and sends what was queued', async ({
  page,
  request,
}) => {
  const taskId = await seedTask('running')
  const stops: string[] = []
  let release = (): void => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(
    (url) => url.pathname === `/api/tasks/${taskId}/stop`,
    async (route) => {
      stops.push(`${route.request().method()} ${new URL(route.request().url()).search}`)
      await held
      await route.fulfill({ json: { data: {}, meta: {} } })
    },
  )
  await openTask(page, taskId)
  await expect(page.getByRole('combobox', { name: 'Reply' })).toHaveAttribute(
    'placeholder',
    'Enter queues it for the agent, Alt+Enter interrupts and sends. Esc stops it.',
  )
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Agent settings' }).click()
  const settings = page.getByRole('dialog')
  await expect(settings).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(settings).toBeHidden()
  expect(stops).toEqual([])

  await page.getByRole('heading', { name: 'Rewind running' }).click()
  await expect(page.getByRole('tooltip')).toHaveCount(0)
  const stopped = page.waitForRequest((req) => new URL(req.url()).pathname === `/api/tasks/${taskId}/stop`)
  await page.keyboard.press('Escape')
  await stopped
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  release()
  await expect.poll(() => stops).toEqual(['POST ?queued=deliver'])
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('Esc stops a running shell command', async ({ page, request }) => {
  const taskId = await seedTask('idle')
  await openTask(page, taskId)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await reply.fill('!sleep 30')
  await reply.press('Enter')
  await expect(reply).toHaveAttribute('placeholder', 'Esc stops the shell command.')
  const stopped = nextApiResponse(page, 'POST', `/tasks/${taskId}/shell/stop`)
  await page.keyboard.press('Escape')
  expect((await stopped).ok()).toBe(true)
  const entry = page.locator('[data-kind="shell"]').filter({ hasText: 'sleep 30' })
  await expect(entry).toContainText('stopped')
  await expect(reply).toBeEnabled()
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})

test('Esc Esc opens Rewind and rewinds the conversation to an earlier prompt', async ({ page, request }) => {
  const taskId = await seedTask('idle')
  await openTask(page, taskId)
  const reply = page.getByRole('combobox', { name: 'Reply' })
  await expect(reply).toHaveAttribute('placeholder', /Esc Esc rewinds/)
  await expect(composerStatus(page)).toBeEmpty()
  const dialog = page.getByRole('dialog', { name: 'Rewind' })

  await reply.fill('/')
  await expect(page.getByRole('listbox', { name: 'Command suggestions' })).toBeVisible()
  await reply.press('Escape')
  await expect(page.getByRole('listbox', { name: 'Command suggestions' })).toBeHidden()
  await reply.fill('')
  await reply.press('Escape')
  await expect(dialog).toBeHidden()
  await reply.press('Escape')
  await expect(dialog).toBeVisible()
  const list = dialog.getByRole('listbox', { name: 'Earlier prompts' })
  await expect(list.getByRole('option')).toHaveText([
    /Also remember the color TEAL\./,
    /Remember the code word PELICAN\./,
  ])
  await expect(list.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
  await list.press('ArrowDown')
  await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await list.press('ArrowUp')

  const preview = nextApiResponse(page, 'GET', `/tasks/${taskId}/rewind/files`)
  await list.press('Enter')
  await preview
  await expect(dialog.getByRole('status', { name: 'Code restore' })).toContainText('Code cannot be restored')
  await expect(dialog.getByRole('button', { name: 'Restore code' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Restore both' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Back' }).click()
  await expect(list).toBeVisible()
  await list.press('Enter')

  const rewound = nextApiResponse(page, 'POST', `/tasks/${taskId}/rewind`)
  await dialog.getByRole('button', { name: 'Restore conversation' }).click()
  expect((await rewound).ok()).toBe(true)
  await expect(dialog).toBeHidden()
  await expect(reply).toHaveValue('Also remember the color TEAL.')

  const group = page.getByRole('button', { name: /2 messages rewound/ })
  await expect(group).toContainText('the next message continues from here')
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('Noted: TEAL.')).toBeHidden()
  await group.click()
  await expect(page.getByText('Noted: TEAL.')).toBeVisible()
  await expect(page.getByText('Noted: PELICAN.')).toBeVisible()

  await page.getByRole('heading', { name: 'Rewind idle' }).click()
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(dialog.getByRole('option')).toHaveText([/Remember the code word PELICAN\./])
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  const audit = await request.get(`/api/audit?kind=task.rewound`)
  const events = ((await audit.json()) as { data: { events: { subject_id: string; detail: unknown }[] } }).data.events
  expect(events.find((event) => event.subject_id === taskId)?.detail).toMatchObject({
    prompt: 'Also remember the color TEAL.',
    messages_rewound: 2,
    restore: 'conversation',
  })
  expect((await request.delete(`/api/tasks/${taskId}`)).ok()).toBe(true)
})
