import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import {
  agentQuestions,
  askingAgent,
  lastReply,
  openRequestsFromMenu,
  requestsSection,
  sectionCount,
  sentLine,
  sentToast,
} from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('on a phone the Requests page goes back, and one Submit all answers two agents and closes it', async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Phone pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Phone checker', CHECKS_PROMPT)

  await page.goto('/#agents')
  await openRequestsFromMenu(page)
  await expect(page).toHaveURL(/#requests$/)
  await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible()
  await expectFitsPhone(page, 'Requests')
  await page.getByRole('button', { name: 'Back', exact: true }).tap()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()

  await openRequestsFromMenu(page)
  await agentQuestions(page, pusher).getByRole('radio', { name: 'No' }).tap()
  const checks = agentQuestions(page, checker)
  await checks.getByRole('checkbox', { name: /E2E/ }).tap()
  await checks.getByRole('radio', { name: /Chat/ }).tap()
  await expect(sentLine(page)).toHaveText('3 of 3 answered')
  await page.getByRole('button', { name: 'Submit all' }).tap()

  await expect(sentToast(page, 'Sent 3 answers')).toBeVisible()
  await expect(page).toHaveURL(/#agents$/)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(requestsSection(page)).toBeVisible()
  await expect(sectionCount(requestsSection(page))).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect.poll(async () => lastReply(request, pusher.id)).toBe(`Got your answers. ${PUSH_QUESTION} No`)
  await expect.poll(async () => lastReply(request, checker.id)).toContain('E2E')
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])
})
