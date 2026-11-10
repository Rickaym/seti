import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, CHECKS_QUESTION, PUSH_PROMPT, PUSH_QUESTION, REPORT_QUESTION } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('two agents ask through AskUserQuestion and one Submit all answers both', async ({ page, request }) => {
  const pusher = await askingAgent(request, 'Pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Checker', CHECKS_PROMPT)
  expect(pusher.blocked).toBe(`Asks a question: ${PUSH_QUESTION}`)
  expect(checker.blocked).toBe(`Asks 2 questions: ${CHECKS_QUESTION}`)

  await page.goto('/#agents')
  await expect(page.getByRole('button', { name: /^Questions, \d+ questions open$/ })).toBeVisible()
  await page.goto(`/#agents/${checker.id}`)
  const needsYou = page.getByRole('main').getByRole('region', { name: 'Needs you' })
  await expect(needsYou.locator(`[data-task-id="${checker.id}"]`)).toContainText('Asks 2 questions')
  const call = page.getByTestId('question-call')
  await expect(call).toContainText('Asked you 2 questions')
  await expect(call).toContainText(`Checks: ${CHECKS_QUESTION}`)
  await expect(call).toContainText('Waiting for you')
  await page.getByRole('button', { name: 'Answer 2 questions' }).click()

  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  const push = agentQuestions(page, pusher)
  const checks = agentQuestions(page, checker)
  await expect(push.getByRole('radiogroup', { name: 'Push' }).getByRole('radio')).toHaveText(['Yes', 'No'])
  await push.getByRole('radio', { name: 'Yes' }).click()
  await checks.getByRole('checkbox', { name: /Unit/ }).click()
  await checks.getByRole('checkbox', { name: /Lint/ }).click()
  await checks.getByRole('textbox', { name: 'Other answer to Checks' }).fill('and the build')
  await checks.getByRole('textbox', { name: 'Other answer to Report' }).fill('Email me')
  await expect(page.getByRole('status')).toHaveText('3 of 3 answered')
  await page.getByRole('button', { name: 'Submit all' }).click()

  await expect(page.getByRole('status')).toContainText('Sent 3 answers. Going on:')
  await expect(page.getByText('No open questions.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Questions, / })).toHaveCount(0)
  await expect.poll(async () => lastReply(request, pusher.id)).toBe(`Got your answers. ${PUSH_QUESTION} Yes`)
  await expect
    .poll(async () => lastReply(request, checker.id))
    .toBe(`Got your answers. ${CHECKS_QUESTION} Unit + Lint + and the build | ${REPORT_QUESTION} Email me`)
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])

  await page.goto(`/#agents/${checker.id}`)
  await expect(call).toContainText('Unit, Lint, and the build')
  await expect(call).toContainText('Email me')
  await expect(page.getByRole('button', { name: 'Answer 2 questions' })).toHaveCount(0)
})

test("Skip dismisses an agent's questions and it goes on without answers", async ({ page, request }) => {
  const skipped = await askingAgent(request, 'Skipped', PUSH_PROMPT)
  await page.goto('/#agents/questions')
  const group = agentQuestions(page, skipped)
  await group.getByRole('button', { name: `Skip ${skipped.title}` }).click()
  await expect(group).toHaveCount(0)
  await expect
    .poll(async () => lastReply(request, skipped.id))
    .toMatch(/^No answers: The user dismissed your questions/)
  await expect
    .poll(async () => (await apiData<{ blocked: string | null }>(request, `/tasks/${skipped.id}`)).blocked)
    .toBeNull()
})
