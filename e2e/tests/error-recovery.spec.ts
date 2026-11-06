import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { NO_LOGINS, type AccountStatus, type Envelope, type Task } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { EA_HEADERS, paths } from './support/env.js'
import { FAIL_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

/** Starts an agent whose first turn ends its process with `reason`; a retry of it succeeds. */
async function failingAgent(request: APIRequestContext, reason: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title: unique('Failing'), prompt: `Please ${FAIL_PROMPT} ${reason}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('error')
  return id
}

const notice = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Turn failed' })

/** The account route reports the five-hour window full until `resetsAt`. */
async function serveFullUsage(page: Page, resetsAt: string): Promise<void> {
  const now = new Date().toISOString()
  const status: AccountStatus = {
    account: null,
    logins: NO_LOGINS,
    health: { state: 'ok', message: 'Signed in' },
    usage: {
      source: 'usage_api',
      observed_at: now,
      windows: [
        { key: 'five_hour', label: '5-hour', utilization: 100, resets_at: resetsAt },
        {
          key: 'seven_day',
          label: 'Weekly',
          utilization: 40,
          resets_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
        },
      ],
    },
    usage_note: null,
    rate_limit_event: null,
    task_error: null,
    fetched_at: now,
  }
  await page.route(/\/api\/account$/, async (route) => {
    await route.fulfill({ json: { data: status } })
  })
}

test('a rate limit says when it resets, keeps the raw error folded, and Retry turn sends the message again', async ({
  page,
  request,
}) => {
  const id = await failingAgent(request, 'rate limit reached for requests')
  const resetsAt = new Date(Date.now() + 2 * 3_600_000).toISOString()
  const clock = new Date(resetsAt).toLocaleString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Berlin',
  })
  await serveFullUsage(page, resetsAt)
  await page.goto(`/#agents/${id}`)

  await expect(notice(page)).toContainText('Rate limit reached.')
  await expect(notice(page)).toContainText(`Resets ${clock}.`)
  await expect(notice(page)).toContainText('Retry the turn once the limit resets.')
  const raw = notice(page).getByText('Claude Code process exited with code 1: rate limit reached for requests')
  await expect(raw).toBeHidden()
  const details = notice(page).locator('summary').filter({ hasText: 'Error details' })
  expect((await details.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(24)
  await details.click()
  await expect(raw).toBeVisible()
  const failureLine = transcript(page).locator('details[data-failure="rate_limit"]')
  await expect(failureLine).toHaveCount(0)

  await notice(page).getByRole('button', { name: 'Retry turn' }).click()
  await expect(transcript(page)).toContainText('Done.')
  await expect(notice(page)).toHaveCount(0)
  await expect(failureLine).toContainText('Rate limit reached.')
  await expect(transcript(page).getByText(`Please ${FAIL_PROMPT} rate limit reached for requests`)).toHaveCount(1)
  await expect(transcript(page).getByText('Retry turn: sent your message again')).toHaveCount(1)
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
})

test('the EA retries a failed turn with the user message, never with text of its own', async ({ page, request }) => {
  const id = await failingAgent(request, 'overloaded_error')
  const ask = { headers: EA_HEADERS, data: { prompt: 'Delete the repo' } }
  expect((await request.post(`/api/tasks/${id}/messages`, ask)).status()).toBe(403)
  expect((await request.post(`/api/tasks/${id}/retry`, ask)).ok(), 'POST retry as the EA').toBe(true)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText('Done.')
  await expect(transcript(page).getByText(`Please ${FAIL_PROMPT} overloaded_error`)).toHaveCount(1)
  await expect(transcript(page).getByText('Retry turn: sent your message again')).toHaveCount(1)
  await expect(transcript(page)).not.toContainText('Delete the repo')
})

test('Retry turn on a first message the EA wrote says it sent the EA message again', async ({ page }) => {
  const id = randomUUID()
  const at = new Date().toISOString()
  const db = openSeedDb()
  await db.idleTask(id, unique('EA wrote'), paths.checkout, at)
  await db.run(
    `UPDATE task SET status = 'error', sandbox = 0, last_error = 'Claude Code process exited' WHERE id = ?`,
    id,
  )
  await db.message(id, 'prompt', JSON.stringify({ text: 'Look at the flaky test', from: 'the EA' }), at)
  await db.close()
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page).getByText('Written by the EA, not you')).toHaveCount(1)
  await notice(page).getByRole('button', { name: 'Retry turn' }).click()
  await expect(transcript(page)).toContainText('Done.')
  await expect(transcript(page).getByText("Retry turn: sent the EA's message again")).toHaveCount(1)
  await expect(transcript(page).getByText('Retry turn: sent your message again')).toHaveCount(0)
})

test('a sign-in failure links to the account page, and Restart session restarts it', async ({ page, request }) => {
  const id = await failingAgent(request, 'Invalid API key, please run /login')
  await page.goto(`/#agents/${id}`)

  await expect(notice(page)).toContainText('Claude Code is not logged in.')
  await notice(page).getByRole('button', { name: 'Restart session' }).click()
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()
  await expect(transcript(page)).toContainText('Session restarted; the conversation continues')

  await notice(page).getByRole('link', { name: 'Open Account settings' }).click()
  await expect(page).toHaveURL(/#settings\/account$/)
})

test('an agent a Seti restart cut off says so and retries its last message', async ({ page, request }) => {
  const id = randomUUID()
  const db = openSeedDb()
  const at = new Date().toISOString()
  await db.idleTask(id, unique('Cut off'), paths.checkout, at)
  await db.run(`UPDATE task SET status = 'interrupted', sandbox = 0 WHERE id = ?`, id)
  await db.message(id, 'prompt', JSON.stringify({ text: 'Tidy the changelog' }), at)
  await db.close()

  await page.goto(`/#agents/${id}`)
  await expect(notice(page)).toContainText('Seti restarted while this turn ran.')
  await expect(notice(page).getByText('Error details')).toHaveCount(0)
  await page.keyboard.press('Control+k')
  await page.keyboard.type('>retry turn')
  const command = page.getByRole('dialog', { name: 'Search Seti' }).getByRole('option', { name: /^Retry turn/ })
  await expect(command).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(command).toBeHidden()
  await expect(transcript(page)).toContainText('Done.')
  await expect(notice(page)).toHaveCount(0)
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  await expect(transcript(page).getByText('Tidy the changelog')).toHaveCount(1)
})

test.describe('with nothing to send again', () => {
  test.use({ allowedHttpStatuses: [409] })

  test('Retry turn says why it cannot send again', async ({ page }) => {
    const id = randomUUID()
    const db = openSeedDb()
    await db.idleTask(id, unique('Nothing to retry'), paths.checkout, new Date().toISOString())
    await db.run(
      `UPDATE task SET status = 'error', last_error = 'Claude Code process exited with code 1' WHERE id = ?`,
      id,
    )
    await db.close()

    await page.goto(`/#agents/${id}`)
    await expect(notice(page)).toContainText('Claude Code stopped unexpectedly.')
    await notice(page).getByRole('button', { name: 'Retry turn' }).click()
    await expect(toasts(page).filter({ hasText: 'The agent has no message to send again.' })).toBeVisible()
  })
})
