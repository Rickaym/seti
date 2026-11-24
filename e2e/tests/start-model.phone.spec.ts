import type { Task } from '@seti/shared'
import { SESSION_PROMPT } from './support/fake-claude.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a phone picks a Claude model for a new agent and the agent starts on it', async ({ page, request }) => {
  await page.goto('/#agents')
  const main = page.getByRole('main')
  await main.getByRole('button', { name: 'New agent' }).tap()
  const model = main.getByRole('combobox', { name: 'Model' })
  await expect(model).toHaveValue('claude:')
  await expectTouchTarget(model, 'model select')
  await model.selectOption('claude:sonnet')
  await expectFitsPhone(page, 'start page with a Claude model picked')

  await main.getByLabel('Message').fill(`Please, ${SESSION_PROMPT}?`)
  await main.getByRole('button', { name: 'Start agent' }).tap()
  await expect(page).toHaveURL(/#agents\/[\da-f-]{36}$/)
  const id = new URL(page.url()).hash.split('/')[1] ?? ''
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).model).toBe('sonnet')
  await page.goto('/#agents')
  expect((await request.delete(`/api/tasks/${id}`)).ok()).toBe(true)
})
