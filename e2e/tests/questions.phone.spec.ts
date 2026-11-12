import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply, sentLine, sentToast } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the Questions page goes back, and one Submit all answers two agents and closes it', async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Phone pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Phone checker', CHECKS_PROMPT)
  const questionsButton = page.getByRole('button', { name: /^Questions, \d+ questions open$/ })

  await page.goto('/#agents')
  await questionsButton.tap()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await expectFitsPhone(page, 'Questions')
  await page.getByRole('button', { name: 'Back', exact: true }).tap()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()

  await questionsButton.tap()
  await agentQuestions(page, pusher).getByRole('radio', { name: 'No' }).tap()
  const checks = agentQuestions(page, checker)
  await checks.getByRole('checkbox', { name: /E2E/ }).tap()
  await checks.getByRole('radio', { name: /Chat/ }).tap()
  await expect(sentLine(page)).toHaveText('3 of 3 answered')
  await page.getByRole('button', { name: 'Submit all' }).tap()

  await expect(sentToast(page, 'Sent 3 answers')).toBeVisible()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Questions, / })).toHaveCount(0)
  await expect.poll(async () => lastReply(request, pusher.id)).toBe(`Got your answers. ${PUSH_QUESTION} No`)
  await expect.poll(async () => lastReply(request, checker.id)).toContain('E2E')
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])
})
