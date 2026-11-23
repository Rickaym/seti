import type { AuditPage, TaskAccessView } from '@seti/shared'
import { seedChangeRequest } from './support/change-requests.js'
import { PERMISSION_DONE, PLAN_STARTED, PLAN_TEXT } from './support/fake-permission.js'
import { PUSH_PROMPT, PUSH_QUESTION } from './support/fake-question.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { proposeAsAgent } from './support/knowledge.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { askingAgent, lastReply, requestsSection, sectionCount, expectNoSentToast } from './support/questions.js'
import {
  archiveOtherWaiting,
  deployingAgent,
  kindFilter,
  needsYouItem,
  pendingTotal,
  planningAgent,
  requestsGroup,
  settleOthers,
} from './support/requests.js'
import { seedAgent } from './support/workspaces.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const HOST = 'panel.fixtures.example.com'

test('one panel answers a question, an access request, a plan, a tool call and a note, counting down', async ({
  page,
  request,
}) => {
  const asker = await askingAgent(request, 'Panel asker', PUSH_PROMPT)
  const access = await seedChangeRequest(
    { kind: 'allow_host', host: HOST, port: 443 },
    `Asks for access to ${HOST}:443`,
  )
  const planner = await planningAgent(request, 'Panel planner')
  const deployer = await deployingAgent(request, 'Panel deployer')
  const noteTitle = unique('Build before the panel suite')
  const { agent: proposer } = await proposeAsAgent(request, noteTitle)
  await settleOthers(request, [asker.id, access.taskId, planner.id, deployer.id, proposer.id])
  expect(await pendingTotal(request)).toBe(5)

  await page.goto('/#agents')
  const row = requestsSection(page)
  await expect(sectionCount(row)).toHaveText('5')
  await expect(row).toHaveAccessibleDescription('5 requests wait on you')
  await row.click()
  await expect(page).toHaveURL(/#requests$/)
  await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible()
  await expect(kindFilter(page).getByRole('button')).toHaveText([
    /^All\s*5$/,
    /^Questions\s*1$/,
    /^Access\s*1$/,
    /^Plans\s*1$/,
    /^Tools\s*1$/,
    /^Notes\s*1$/,
  ])
  const groups = page.getByRole('main').getByRole('region', { name: /^Requests from / })
  await expect(groups).toHaveCount(5)
  await expect(groups.last()).toHaveAccessibleName(`Requests from ${proposer.title}`)
  const asking = requestsGroup(page, asker.title)
  await expect(asking.getByRole('button', { name: `Open ${asker.title}` })).toContainText(
    `Asks a question: ${PUSH_QUESTION}`,
  )
  await expect(asking.getByRole('img', { name: 'waits on you' })).toBeVisible()

  await kindFilter(page)
    .getByRole('button', { name: /^Plans/ })
    .click()
  await expect(groups).toHaveCount(1)
  const plan = requestsGroup(page, planner.title).getByRole('region', { name: 'Plan approval' })
  await expect(plan).toContainText(PLAN_TEXT)
  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(sectionCount(row)).toHaveText('4')
  await expect(kindFilter(page).getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => lastReply(request, planner.id)).toBe(PLAN_STARTED)

  const change = requestsGroup(page, access.title).getByRole('region', { name: /^Change request: / })
  await expect(change).toContainText(`Let this agent reach ${HOST}:443?`)
  await expect(change).toContainText('The tests download fixtures from there.')
  await expect(change).toContainText(`+ ${HOST}:443`)
  await change.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(change).toHaveCount(0)
  await expect(sectionCount(row)).toHaveText('3')
  expect((await apiData<TaskAccessView>(request, `/tasks/${access.taskId}/access`)).hosts).toEqual([`${HOST}:443`])
  const audit = await apiData<AuditPage>(request, '/audit?kind=task.change_allowed&limit=1')
  expect(audit.events[0]).toMatchObject({
    actor: 'user',
    subject_id: access.taskId,
    detail: { request_id: access.requestId },
  })
  expect(audit.events[0]?.detail).not.toHaveProperty('via', 'ea')

  const tool = requestsGroup(page, deployer.title).getByRole('region', { name: 'Permission request for Bash' })
  await tool.getByRole('button', { name: 'Allow', exact: true }).click()
  await expect(sectionCount(row)).toHaveText('2')
  await expect.poll(async () => lastReply(request, deployer.id)).toBe(PERMISSION_DONE)

  const note = requestsGroup(page, proposer.title).getByRole('article', { name: `Note: ${noteTitle}` })
  await note.getByRole('button', { name: 'Approve' }).click()
  await expect(toasts(page).filter({ hasText: 'Approved' })).toBeVisible()
  await expect(sectionCount(row)).toHaveText('1')
  await expect(kindFilter(page)).toHaveCount(0)

  await asking.getByRole('radio', { name: 'Yes' }).click()
  await page.getByRole('button', { name: 'Submit all' }).click()
  await expect(page).toHaveURL(/#agents$/)
  await expectNoSentToast(page)
  await expect(sectionCount(row)).toHaveCount(0)
  await expect.poll(async () => lastReply(request, asker.id)).toBe(`Got your answers. ${PUSH_QUESTION} Yes`)
})

test("an agent's drawer holds its requests of every kind, and Deny tells the agent", async ({ page, request }) => {
  const planner = await planningAgent(request, 'Drawer planner')
  await page.goto(`/#agents/${planner.id}`)
  await page.getByRole('button', { name: 'Answer 1 request' }).click()
  const drawer = page.getByRole('region', { name: 'Agent requests' })
  await expect(drawer.getByRole('region', { name: 'Plan approval' })).toContainText(PLAN_TEXT)
  await drawer.getByRole('textbox', { name: 'Note for the agent if you deny' }).fill('Write the test first')
  await drawer.getByRole('button', { name: 'Deny' }).click()
  await expect(drawer).toHaveCount(0)
  await expect
    .poll(async () => lastReply(request, planner.id))
    .toBe('Not starting: The user denied this tool call and said: Write the test first')
})

test('the status bar opens Requests while each agent that needs you has a request there', async ({ page, request }) => {
  const asker = await askingAgent(request, 'Status asker', PUSH_PROMPT)
  await archiveOtherWaiting(request, [asker.id])
  await page.goto('/#home')
  const item = needsYouItem(page)
  await expect(item).toHaveText('1 need you')
  await item.hover()
  await expect(page.getByRole('tooltip')).toContainText('Click to answer them in Requests.')
  await item.click()
  await expect(page).toHaveURL(/#requests$/)
  await expect(requestsGroup(page, asker.title)).toBeVisible()

  const failed = await seedAgent(unique('Failed elsewhere'), { status: 'error' })
  await expect(item).toHaveText('2 need you')
  await item.click()
  await expect(page).toHaveURL(/#agents$/)
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Needs you' }).locator(`[data-task-id="${failed}"]`),
  ).toBeVisible()
  await settleOthers(request, [])
  await archiveOtherWaiting(request, [])
})
