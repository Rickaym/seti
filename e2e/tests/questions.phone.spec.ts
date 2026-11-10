import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply, sentLine } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the user answers two agents on the Questions page with one Submit all', async ({ page, request }) => {
  const pusher = await askingAgent(request, 'Phone pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Phone checker', CHECKS_PROMPT)

  await page.goto(`/#agents/${pusher.id}`)
  await page.getByRole('button', { name: 'Answer 1 question' }).click()
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible()
  await expectFitsPhone(page, 'Questions')

  await agentQuestions(page, pusher).getByRole('radio', { name: 'No' }).click()
  const checks = agentQuestions(page, checker)
  await checks.getByRole('checkbox', { name: /E2E/ }).click()
  await checks.getByRole('radio', { name: /Chat/ }).click()
  await expect(sentLine(page)).toHaveText('3 of 3 answered')
  await page.getByRole('button', { name: 'Submit all' }).click()

  await expect(sentLine(page)).toContainText('Sent 3 answers')
  await expect(page.getByText('No open questions.')).toBeVisible()
  await expect.poll(async () => lastReply(request, pusher.id)).toBe(`Got your answers. ${PUSH_QUESTION} No`)
  await expect.poll(async () => lastReply(request, checker.id)).toContain('E2E')
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])

  await page.getByRole('button', { name: 'Back to agents' }).click()
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Questions, / })).toHaveCount(0)
})
