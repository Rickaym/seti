import type { AuditPage } from '@seti/shared'
import { seedChangeRequest } from './support/change-requests.js'
import { PLAN_STARTED, PLAN_TEXT } from './support/fake-permission.js'
import { PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test, unique } from './support/fixtures.js'
import { proposeAsAgent } from './support/knowledge.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { askingAgent, lastReply, openRequestsFromMenu, requestsSection, sectionCount } from './support/questions.js'
import { kindFilter, pendingTotal, planningAgent, requestsGroup, settleOthers } from './support/requests.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const HOST = 'phone.panel.example.com'

test('on a phone one thumb answers a question, an access request, a plan and a note, and the page closes', async ({
  page,
  request,
}) => {
  const asker = await askingAgent(request, 'Phone panel asker', PUSH_PROMPT)
  const access = await seedChangeRequest(
    { kind: 'allow_host', host: HOST, port: 443 },
    `Asks for access to ${HOST}:443`,
  )
  const planner = await planningAgent(request, 'Phone panel planner')
  const noteTitle = unique('Phone panel note')
  const { agent: proposer } = await proposeAsAgent(request, noteTitle)
  await settleOthers(request, [asker.id, access.taskId, planner.id, proposer.id])
  expect(await pendingTotal(request)).toBe(4)

  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await expect(sectionCount(requestsSection(page))).toHaveText('4')
  await requestsSection(page).tap()
  await expect(page).toHaveURL(/#requests$/)
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible()
  await expect(page.getByRole('main').getByRole('region', { name: /^Requests from / })).toHaveCount(4)
  await expectFitsPhone(page, 'Requests with every kind')
  for (const chip of await kindFilter(page).getByRole('button').all()) {
    expect((await chip.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44)
  }

  const change = requestsGroup(page, access.title).getByRole('region', { name: /^Change request: / })
  await expect(change).toContainText(`+ ${HOST}:443`)
  await change.getByRole('button', { name: 'Allow', exact: true }).tap()
  await expect(change).toHaveCount(0)
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.change_allowed&limit=1')
  expect(audit.events[0]).toMatchObject({ actor: 'user', detail: { request_id: access.requestId } })

  await kindFilter(page)
    .getByRole('button', { name: /^Plans/ })
    .tap()
  const plan = requestsGroup(page, planner.title).getByRole('region', { name: 'Plan approval' })
  await expect(plan).toContainText(PLAN_TEXT)
  await expectFitsPhone(page, 'Requests showing plans')
  await plan.getByRole('button', { name: 'Approve' }).tap()
  await expect.poll(async () => lastReply(request, planner.id)).toBe(PLAN_STARTED)

  await requestsGroup(page, proposer.title)
    .getByRole('article', { name: `Note: ${noteTitle}` })
    .getByRole('button', { name: 'Reject' })
    .tap()
  await requestsGroup(page, asker.title).getByRole('radio', { name: 'No' }).tap()
  await page.getByRole('button', { name: 'Submit all' }).tap()
  await expect(page).toHaveURL(/#agents$/)
  await expect.poll(async () => lastReply(request, asker.id)).toBe(`Got your answers. ${PUSH_QUESTION} No`)
  expect(await pendingTotal(request)).toBe(0)
  await openRequestsFromMenu(page)
  await expect(page.getByRole('main')).toContainText('Nothing waits on you.')
})

test("on a phone an agent's drawer covers the screen with its plan and closes once it is approved", async ({
  page,
  request,
}) => {
  const planner = await planningAgent(request, 'Phone drawer planner')
  await page.goto(`/#agents/${planner.id}`)
  await page.getByRole('button', { name: 'Answer 1 request' }).tap()
  const drawer = page.getByRole('region', { name: 'Agent requests' })
  const viewport = page.viewportSize()
  const box = await drawer.boundingBox()
  expect(box?.x).toBe(0)
  expect(box?.width).toBe(viewport?.width)
  await expectFitsPhone(page, 'Requests drawer with a plan')
  await drawer.getByRole('button', { name: 'Approve' }).tap()
  await expect(drawer).toHaveCount(0)
  await expect.poll(async () => lastReply(request, planner.id)).toBe(PLAN_STARTED)
})
