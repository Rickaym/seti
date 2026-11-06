import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { HOLD_PROMPT, SESSION_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { startSessionAgent, transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('restarts an idle agent from its settings, and the next message resumes the session', async ({
  page,
  request,
}) => {
  const { id, session } = await startSessionAgent(request)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(transcript(page)).toContainText(`Session ${session}, resumed none`)

  await main.getByRole('button', { name: 'Agent settings' }).click()
  await page.getByRole('button', { name: 'Restart session' }).click()
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await expect(dialog).toContainText('The conversation is kept')
  await expect(dialog).toContainText('MCP servers, plugins, tools and settings')
  await expect(dialog).toContainText('Background shells, processes and subagents it started end')
  await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()
  await expect(transcript(page)).toContainText('Session restarted; the conversation continues')

  await main.getByRole('combobox', { name: 'Reply' }).fill(`And now, ${SESSION_PROMPT}?`)
  await main.getByRole('combobox', { name: 'Reply' }).press('Enter')
  await expect(transcript(page)).toContainText(`Session ${session}, resumed ${session}`)
  expect((await apiData<Task>(request, `/tasks/${id}`)).session_id).toBe(session)
})

test('offers to stop a working agent before restarting its session', async ({ page, request }) => {
  const { id } = await startSessionAgent(request)
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: HOLD_PROMPT } })
  expect(sent.ok()).toBe(true)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(transcript(page)).toContainText('Working on it.')

  await main.getByRole('button', { name: 'Agent settings' }).click()
  await page.getByRole('button', { name: 'Restart session' }).click()
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await expect(dialog).toContainText('It is working now, so its turn stops first.')
  await dialog.getByRole('button', { name: 'Stop and restart' }).click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()
  await expect(transcript(page)).toContainText('Session restarted; the conversation continues')
  expect((await apiData<Task>(request, `/tasks/${id}`)).status).toBe('stopped')
})

test('a sandbox switch during a turn offers to restart now so it applies at once', async ({ page, request }) => {
  const { id } = await startSessionAgent(request)
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: HOLD_PROMPT } })
  expect(sent.ok()).toBe(true)
  await page.goto(`/#agents/${id}`)
  await expect(transcript(page)).toContainText('Working on it.')

  const details = await openAgentSettings(page, 'Access')
  const sandbox = details.getByRole('button', { name: 'Sandbox' })
  const restartNow = details.getByRole('button', { name: 'Restart now' })
  await expect(restartNow).toHaveCount(0)
  await sandbox.click()
  await expect(toasts(page).filter({ hasText: 'Applies from the next turn, or restart now' })).toBeVisible()
  await expect(restartNow).toBeVisible()
  await sandbox.click()
  await expect(sandbox).toHaveAttribute('aria-pressed', 'false')
  await expect(restartNow).toHaveCount(0)
  await sandbox.click()
  await expect(sandbox).toHaveAttribute('aria-pressed', 'true')

  await restartNow.click()
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await dialog.getByRole('button', { name: 'Stop and restart' }).click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()
  await expect
    .poll(async () => {
      const task = await apiData<Task>(request, `/tasks/${id}`)
      return [task.status, task.sandbox]
    })
    .toEqual(['stopped', true])
})

test('restarts the open agent from the palette, and starts it fresh behind a warning', async ({ page, request }) => {
  const { id, session } = await startSessionAgent(request)
  await page.goto(`/#agents/${id}`)
  const main = page.getByRole('main')
  await expect(transcript(page)).toContainText(`Session ${session}, resumed none`)

  await page.keyboard.press('Control+k')
  await page.keyboard.type('>restart session')
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Restart session' })
  await dialog.getByRole('button', { name: 'Restart', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()

  await page.keyboard.press('Control+k')
  await page.keyboard.type('>fresh session')
  await page.keyboard.press('Enter')
  const fresh = page.getByRole('dialog', { name: 'Start fresh session' })
  await expect(fresh).toContainText('The agent forgets this conversation')
  await fresh.getByRole('button', { name: 'Start fresh', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Fresh session started' })).toBeVisible()
  await expect(transcript(page)).toContainText('Fresh session started')

  await main.getByRole('combobox', { name: 'Reply' }).fill(`And now, ${SESSION_PROMPT}?`)
  await main.getByRole('combobox', { name: 'Reply' }).press('Enter')
  await expect(transcript(page)).toContainText(/Session [\w-]+, resumed none[\s\S]*Session [\w-]+, resumed none/)
  expect((await apiData<Task>(request, `/tasks/${id}`)).session_id).not.toBe(session)
})
