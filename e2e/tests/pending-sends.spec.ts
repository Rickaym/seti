import type { Locator, Page, Route } from '@playwright/test'
import type { MessagePage, SendMessageInput } from '@seti/shared'
import { HOLD_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test } from './support/fixtures.js'
import { startAgent } from './support/many-prs.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, allowedConsoleErrors: [/net::ERR_/] })

const reply = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const transcript = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Transcript' })
const pendingRows = (page: Page) => page.locator('[data-pending-send]')
const pendingRow = (page: Page, text: string) => pendingRows(page).filter({ hasText: text })
const ownRows = (page: Page, text: string) => page.locator('[data-own-message]').filter({ hasText: text })

/** Holds each POST to the task's messages until released, recording the bodies in order. */
async function holdSends(page: Page, taskId: string) {
  const bodies: SendMessageInput[] = []
  let open: () => void = () => undefined
  let gate = new Promise<void>((resolve) => {
    open = resolve
  })
  let mode: 'hold' | 'pass' | 'abort' | 'refuse' = 'hold'
  await page.route(`**/api/tasks/${taskId}/messages`, async (route: Route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback()
      return
    }
    bodies.push(route.request().postDataJSON() as SendMessageInput)
    if (mode === 'abort') {
      await route.abort('connectionfailed')
      return
    }
    if (mode === 'refuse') {
      await route.fulfill({ status: 409, json: { error: { detail: 'The agent cannot take messages now' } } })
      return
    }
    if (mode === 'hold') {
      await gate
    }
    await route.continue().catch(() => undefined)
  })
  return {
    bodies,
    release: () => {
      mode = 'pass'
      open()
      gate = new Promise<void>((resolve) => {
        open = resolve
      })
    },
    set: (next: typeof mode) => {
      mode = next
    },
  }
}

/** Ms from the Enter keydown to the pending row being in the page. */
async function watchPendingLatency(page: Page): Promise<void> {
  await page.evaluate(() => {
    const marks: { key?: number; row?: number } = {}
    Reflect.set(window, '__pendingMarks', marks)
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Enter') {
          marks.key ??= performance.now()
        }
      },
      { capture: true },
    )
    new MutationObserver(() => {
      if (marks.row === undefined && document.querySelector('[data-pending-send]') !== null) {
        marks.row = performance.now()
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
}

const pendingLatency = async (page: Page) =>
  page.evaluate(() => {
    const marks = Reflect.get(window, '__pendingMarks') as { key?: number; row?: number }
    return (marks.row ?? Number.POSITIVE_INFINITY) - (marks.key ?? 0)
  })

const opacityOf = async (row: Locator) =>
  row
    .locator(':scope > div')
    .first()
    .evaluate((box) => getComputedStyle(box).opacity)

async function storedPrompts(page: Page, taskId: string, text: string) {
  const rows = await apiData<MessagePage>(page.request, `/tasks/${taskId}/messages?limit=100`)
  return rows.messages.filter((row) => row.kind === 'prompt' && row.payload.text === text)
}

test('a held send shows at once, faded, and becomes one normal row in place', async ({ page }) => {
  const agent = await startAgent(page.request, 'Pending row')
  const sends = await holdSends(page, agent.id)
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('Done.')
  await watchPendingLatency(page)

  await reply(page).fill('Shown before the server answers')
  await reply(page).press('Enter')
  const row = pendingRow(page, 'Shown before the server answers')
  await expect(row).toBeVisible()
  expect(await pendingLatency(page)).toBeLessThan(100)
  await expect(reply(page)).toHaveValue('')
  await expect(row).toContainText('Sending...')
  expect(await opacityOf(row)).toBe('0.6')
  const before = await row.locator(':scope > div').first().boundingBox()

  sends.release()
  const stored = ownRows(page, 'Shown before the server answers')
  await expect(stored).toHaveCount(1)
  await expect(pendingRows(page)).toHaveCount(0)
  await expect(transcript(page).getByText('Shown before the server answers', { exact: true })).toHaveCount(1)
  const after = await stored.locator('[data-find-text]').boundingBox()
  expect(after?.height).toBe(before?.height)
  expect(sends.bodies).toHaveLength(1)
  const [prompt] = await storedPrompts(page, agent.id, 'Shown before the server answers')
  expect(prompt?.kind === 'prompt' && prompt.payload.client_id).toBe(sends.bodies[0]?.client_id)
})

test('a send whose retries all fail stays as a failed row that Retry sends once', async ({ page }) => {
  const agent = await startAgent(page.request, 'Pending retry')
  const sends = await holdSends(page, agent.id)
  sends.set('abort')
  await page.clock.install()
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('Done.')

  await reply(page).fill('Lost on a dead network')
  await reply(page).press('Enter')
  const row = pendingRow(page, 'Lost on a dead network')
  await expect(row).toBeVisible()
  await expect(reply(page)).toHaveValue('')
  await expect(row).toContainText('Sending... retrying')
  await expect
    .poll(async () => {
      await page.clock.fastForward(16_000)
      return row.getAttribute('data-state')
    })
    .toBe('failed')
  expect(sends.bodies).toHaveLength(5)
  expect(new Set(sends.bodies.map((body) => body.client_id)).size).toBe(1)
  await expect(row).toContainText('Not sent: Seti could not be reached')
  expect(await opacityOf(row)).toBe('0.6')
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)

  sends.set('pass')
  await row.getByRole('button', { name: 'Retry' }).click()
  await expect(ownRows(page, 'Lost on a dead network')).toHaveCount(1)
  await expect(pendingRows(page)).toHaveCount(0)
  expect(sends.bodies).toHaveLength(6)
  expect(sends.bodies[5]?.client_id).toBe(sends.bodies[0]?.client_id)
  await expect.poll(async () => (await storedPrompts(page, agent.id, 'Lost on a dead network')).length).toBe(1)
})

test.describe('a refused send', () => {
  test.use({ allowedHttpStatuses: [409] })

  test('Edit moves a failed message back into the reply box', async ({ page }) => {
    const agent = await startAgent(page.request, 'Pending edit')
    const sends = await holdSends(page, agent.id)
    sends.set('refuse')
    await page.goto(`/#agents/${agent.id}`)
    await expect(transcript(page)).toContainText('Done.')

    await reply(page).fill('Needs another look')
    await reply(page).press('Enter')
    const row = pendingRow(page, 'Needs another look')
    await expect(row).toHaveAttribute('data-state', 'failed')
    await expect(row).toContainText('The agent cannot take messages now')
    await expect(page.locator('[data-sonner-toast]')).toHaveCount(0)
    await reply(page).fill('and more')

    await row.getByRole('button', { name: 'Edit' }).click()
    await expect(pendingRows(page)).toHaveCount(0)
    await expect(reply(page)).toHaveValue('Needs another look\nand more')
    expect(sends.bodies).toHaveLength(1)
  })

  test('Delete drops a failed message and leaves the reply box alone', async ({ page }) => {
    const agent = await startAgent(page.request, 'Pending delete')
    const sends = await holdSends(page, agent.id)
    sends.set('refuse')
    await page.goto(`/#agents/${agent.id}`)
    await expect(transcript(page)).toContainText('Done.')

    await reply(page).fill('Never mind')
    await reply(page).press('Enter')
    const row = pendingRow(page, 'Never mind')
    await expect(row).toHaveAttribute('data-state', 'failed')
    await reply(page).fill('draft stays')

    await row.getByRole('button', { name: 'Delete' }).click()
    await expect(pendingRows(page)).toHaveCount(0)
    await expect(reply(page)).toHaveValue('draft stays')
    await page.reload()
    await expect(transcript(page)).toContainText('Done.')
    await expect(pendingRows(page)).toHaveCount(0)
    expect(sends.bodies).toHaveLength(1)
  })
})

test('a send pending across a reload still shows and goes through once', async ({ page }) => {
  const agent = await startAgent(page.request, 'Pending reload')
  const sends = await holdSends(page, agent.id)
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('Done.')

  await reply(page).fill('Typed just before the tab closed')
  await reply(page).press('Enter')
  await expect(pendingRow(page, 'Typed just before the tab closed')).toBeVisible()
  await expect.poll(() => sends.bodies.length).toBe(1)

  await page.reload()
  sends.release()
  await expect(ownRows(page, 'Typed just before the tab closed')).toHaveCount(1)
  await expect(pendingRows(page)).toHaveCount(0)
  expect(sends.bodies.length).toBeGreaterThanOrEqual(2)
  expect(new Set(sends.bodies.map((body) => body.client_id)).size).toBe(1)
  await expect
    .poll(async () => (await storedPrompts(page, agent.id, 'Typed just before the tab closed')).length)
    .toBe(1)
  await expect
    .poll(async () =>
      page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('seti.pending-sends.'))),
    )
    .toEqual([])
})

test('quick sends keep their order and each lands as its own row', async ({ page }) => {
  const agent = await startAgent(page.request, 'Pending order')
  const sends = await holdSends(page, agent.id)
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('Done.')

  for (const text of ['First of three', 'Second of three', 'Third of three']) {
    await reply(page).fill(text)
    await reply(page).press('Enter')
  }
  await expect(pendingRows(page)).toHaveText([/First of three/, /Second of three/, /Third of three/])
  expect(sends.bodies.map((body) => body.prompt)).toEqual(['First of three'])

  sends.release()
  await expect(pendingRows(page)).toHaveCount(0)
  await expect(page.locator('[data-own-message]').filter({ hasText: /of three/ })).toHaveText([
    /First of three/,
    /Second of three/,
    /Third of three/,
  ])
  expect(sends.bodies.map((body) => body.prompt)).toEqual(['First of three', 'Second of three', 'Third of three'])
  for (const text of ['First of three', 'Second of three', 'Third of three']) {
    await expect(transcript(page).getByText(text, { exact: true })).toHaveCount(1)
  }
})

test('a send while the agent works ends as a queued row', async ({ page }) => {
  const agent = await startAgent(page.request, 'Pending queued')
  await page.goto(`/#agents/${agent.id}`)
  await expect(transcript(page)).toContainText('Done.')
  expect((await page.request.post(`/api/tasks/${agent.id}/messages`, { data: { prompt: HOLD_PROMPT } })).ok()).toBe(
    true,
  )
  await expect(transcript(page)).toContainText('Working on it.')
  const sends = await holdSends(page, agent.id)

  await reply(page).fill('Queue this behind the turn')
  await reply(page).press('Enter')
  const row = pendingRow(page, 'Queue this behind the turn')
  await expect(row).toContainText('Sending...')
  await expect(row).not.toContainText('queued')

  sends.release()
  const stored = ownRows(page, 'Queue this behind the turn')
  await expect(stored).toContainText('queued')
  await expect(pendingRows(page)).toHaveCount(0)
  await expect(transcript(page).getByText('Queue this behind the turn', { exact: true })).toHaveCount(1)
  expect((await page.request.post(`/api/tasks/${agent.id}/stop`, { data: {} })).ok()).toBe(true)
})
