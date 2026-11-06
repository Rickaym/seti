import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { MessagePage } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, nextApiResponse, test } from './support/fixtures.js'

const STEPS = 300
const BIG_STEP = STEPS - 5
const BIG_TAIL = 'END OF THE LARGE TOOL OUTPUT'
const END_MARKER = 'Seeded transcript ends here.'

const TURN_DONE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 64_000,
  num_turns: STEPS,
  result: END_MARKER,
  total_cost_usd: 1.25,
  session_id: 'seeded-session',
  uuid: randomUUID(),
}

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  message: { id: randomUUID(), type: 'message', role: 'assistant', model: 'claude', content },
  parent_tool_use_id: null,
  session_id: 'seeded-session',
  uuid: randomUUID(),
})

const toolResult = (toolUseId: string, content: string) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  parent_tool_use_id: null,
  session_id: 'seeded-session',
  uuid: randomUUID(),
  tool_use_result: { stdout: content, stderr: '' },
})

function stepMessages(step: number): unknown[] {
  const id = `toolu_seed_${String(step)}`
  const output = step === BIG_STEP ? `${'log line\n'.repeat(20_000)}${BIG_TAIL}` : `ok ${String(step)}`
  return [
    assistant([{ type: 'text', text: `Seeded step ${String(step)} of the long task.` }]),
    assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: `echo step-${String(step)}` } }]),
    toolResult(id, output),
  ]
}

/** Writes a finished task with a long transcript straight into the server's database. */
async function seedTask(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const ts = new Date().toISOString()
  await db.run(
    `INSERT INTO task (id, title, repo_id, cwd, worktree, status, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 0, 'idle', ?, ?)`,
    id,
    'Seeded long transcript',
    paths.checkout,
    ts,
    ts,
  )
  const payloads: [string, unknown][] = [['prompt', { text: 'Seeded prompt that starts the transcript.' }]]
  for (let step = 0; step < STEPS; step++) {
    payloads.push(...stepMessages(step).map((payload): [string, unknown] => ['sdk', payload]))
  }
  payloads.push(['sdk', assistant([{ type: 'text', text: END_MARKER }])], ['sdk', TURN_DONE])
  await db.run('BEGIN')
  for (const [kind, payload] of payloads) {
    await db.message(id, kind, JSON.stringify(payload), ts)
  }
  await db.run('COMMIT')
  await db.close()
  return id
}

const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const renderedIds = async (pane: Locator) =>
  pane.locator('[data-message-id]').evaluateAll((nodes) => nodes.map((node) => Number(node.dataset.messageId)))

/** Scrolls to the top, which starts loading the previous page, and returns the first row there. */
const scrollToTop = async (pane: Locator) =>
  pane.evaluate((el) => {
    el.scrollTo({ top: 0 })
    const top = el.getBoundingClientRect().top
    const node = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
      (n) => n.getBoundingClientRect().bottom > top,
    )
    return { id: node?.dataset.messageId, offset: Math.round((node?.getBoundingClientRect().top ?? 0) - top) }
  })

const rowOffset = async (pane: Locator, id: string) =>
  pane.evaluate((el, rowId) => {
    const node = el.querySelector(`[data-message-id="${rowId}"]`)
    return Math.round((node?.getBoundingClientRect().top ?? Number.NaN) - el.getBoundingClientRect().top)
  }, id)

test.describe('long transcripts', () => {
  let taskId = ''

  test.beforeAll(async () => {
    taskId = await seedTask()
  })

  test('opens on the newest messages and pages back on demand', async ({ page }) => {
    const pages: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/tasks/${taskId}/messages`) {
        pages.push(request.url())
      }
    })
    await page.goto(`/#agents/${taskId}`)
    const pane = transcript(page)
    await expect(pane.getByText(END_MARKER)).toBeVisible()
    await expect(pane.getByText(`Seeded step ${String(STEPS - 1)} of`)).toBeAttached()
    await expect(pane.getByText('Seeded step 0 of')).toHaveCount(0)
    const firstIds = await renderedIds(pane)
    expect(pages, 'earlier pages loaded unasked').toEqual([])
    expect(firstIds.length).toBeLessThan(120)
    await expect(pane.getByText(/^Turn done \u00b7 300 steps/)).toBeVisible()
    await expect(pane.getByText('Tool output').first()).toBeAttached()

    const loadButton = pane.getByRole('button', { name: 'Load earlier' })
    await expect(loadButton).toBeAttached()
    const firstPage = nextApiResponse(page, 'GET', `/tasks/${taskId}/messages`)
    await loadButton.dispatchEvent('click')
    const body = (await (await firstPage).json()) as { data: MessagePage }
    expect(body.data.messages).toHaveLength(100)
    expect(body.data.messages.at(-1)?.id).toBe((firstIds[0] ?? 0) - 1)
    await expect.poll(async () => (await renderedIds(pane)).length).toBeGreaterThan(firstIds.length)
    await expect(pane.getByText('Tool output')).toHaveCount(0)

    const loaded = (await renderedIds(pane)).length
    const anchored = await scrollToTop(pane)
    await expect.poll(async () => (await renderedIds(pane)).length).toBeGreaterThan(loaded)
    expect(Math.abs((await rowOffset(pane, anchored.id ?? '')) - anchored.offset)).toBeLessThan(4)

    let shown = (await renderedIds(pane)).length
    while ((await loadButton.count()) > 0) {
      const earlier = nextApiResponse(page, 'GET', `/tasks/${taskId}/messages`)
      await scrollToTop(pane)
      await earlier
      await expect.poll(async () => (await renderedIds(pane)).length).toBeGreaterThan(shown)
      shown = (await renderedIds(pane)).length
    }
    await expect(pane.getByText('Seeded prompt that starts the transcript.')).toBeAttached()
    await expect(pane.getByText('Seeded step 0 of')).toBeAttached()
  })

  test('fetches the full output of a trimmed tool result', async ({ page }) => {
    await page.goto(`/#agents/${taskId}`)
    const pane = transcript(page)
    await expect(pane.getByText(END_MARKER)).toBeVisible()
    const call = pane.locator('details').filter({ hasText: `echo step-${String(BIG_STEP)}` })
    await call.locator('summary').click()
    await expect(call.getByText('Trimmed for display.')).toBeVisible()
    await expect(call.getByText(/\[trimmed for display: first 16 KB of \d+ KB shown\]/)).toBeAttached()
    await expect(call.getByText(BIG_TAIL)).toHaveCount(0)

    const fullMessage = page.waitForResponse((res) =>
      new RegExp(`/api/tasks/${taskId}/messages/\\d+$`).test(new URL(res.url()).pathname),
    )
    await call.getByRole('button', { name: 'Full output' }).click()
    expect(await (await fullMessage).text()).toContain(BIG_TAIL)
    await expect(call.getByText(BIG_TAIL)).toBeAttached()
    await expect(call.getByRole('button', { name: 'Full output' })).toHaveCount(0)
    await expect(call.getByText('Trimmed for display.')).toHaveCount(0)
  })
})
