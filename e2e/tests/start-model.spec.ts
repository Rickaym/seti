import type { Page } from '@playwright/test'
import type { Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { SESSION_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test, toasts } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { transcript } from './support/restart.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const agentId = (page: Page) => new URL(page.url()).hash.split('/')[1] ?? ''

test('a new agent starts on the Claude model picked for it and keeps it across a restart', async ({
  page,
  request,
}) => {
  await page.goto('/#agents/new')
  const main = page.getByRole('main')
  const model = main.getByRole('combobox', { name: 'Model' })
  await expect(model).toHaveValue('claude:')
  expect(await model.locator('optgroup').evaluateAll((all) => all.map((g) => g.getAttribute('label')))).toEqual([
    'Claude Code',
  ])
  await model.selectOption('claude:sonnet')
  await expect(main.getByRole('button', { name: 'Sandbox', exact: true })).toBeVisible()
  await main.getByLabel('Message').fill(`Please, ${SESSION_PROMPT}?`)
  await main.getByLabel('Message').press('Enter')
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const id = agentId(page)
  await expect(transcript(page)).toContainText('resumed none')
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).model).toBe('sonnet')
  expect(await apiData<Task>(request, `/tasks/${id}`)).toMatchObject({ runtime: 'claude', requested_model: 'sonnet' })

  const session = await openAgentSettings(page, 'Session')
  await expect(session.getByTestId('task-model')).toHaveText('sonnet')
  await expect(session.getByText('Claude Code, sonnet', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restart session' }).click()
  await page
    .getByRole('dialog', { name: 'Restart session' })
    .getByRole('button', { name: 'Restart', exact: true })
    .click()
  await expect(toasts(page).filter({ hasText: 'Session restarted' })).toBeVisible()

  await main.getByRole('combobox', { name: 'Reply' }).fill(`And now, ${SESSION_PROMPT}?`)
  await main.getByRole('combobox', { name: 'Reply' }).press('Enter')
  await expect(transcript(page)).toContainText(/resumed [\da-f-]{36}/)
  expect((await apiData<Task>(request, `/tasks/${id}`)).model).toBe('sonnet')
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
