import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, PUSH_PROMPT } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply, questionsDrawer, sentToast } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the Questions drawer covers the screen, holds one agent and closes once answered', async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Phone drawer pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Phone drawer checker', CHECKS_PROMPT)

  await page.goto(`/#agents/${checker.id}`)
  await page.getByRole('button', { name: 'Answer 2 questions' }).tap()
  const drawer = questionsDrawer(page)
  await expect(drawer).toBeVisible()
  const viewport = page.viewportSize()
  const box = await drawer.boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.width).toBe(viewport?.width)
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBeGreaterThanOrEqual((viewport?.height ?? 0) - 40)
  await expectFitsPhone(page, 'Questions drawer')
  await expect(drawer.getByRole('region', { name: /^Questions from / })).toHaveCount(1)
  await expect(agentQuestions(page, pusher)).toHaveCount(0)

  const checks = agentQuestions(page, checker)
  await checks.getByRole('checkbox', { name: /E2E/ }).tap()
  await checks.getByRole('radio', { name: /Chat/ }).tap()
  await expect(drawer.getByRole('status')).toHaveText('2 of 2 answered')
  await drawer.getByRole('button', { name: 'Submit', exact: true }).tap()
  await expect(drawer).toHaveCount(0)
  await expect(sentToast(page, 'Sent 2 answers')).toBeVisible()
  await expect(page.getByTestId('agent-header')).toBeVisible()
  await expect.poll(async () => lastReply(request, checker.id)).toContain('E2E')

  await page.getByRole('button', { name: 'Back to agents' }).tap()
  const needsYou = page.getByRole('main').getByRole('region', { name: 'Needs you' })
  await needsYou.locator(`[data-task-id="${pusher.id}"]`).tap()
  await expect(page).toHaveURL(new RegExp(`#agents/${pusher.id}$`))
  await expect(drawer).toBeVisible()
  await agentQuestions(page, pusher).getByRole('button', { name: 'Dismiss Push' }).tap()
  await expect(drawer).toHaveCount(0)
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])
})
