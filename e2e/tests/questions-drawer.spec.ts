import type { Question } from '@seti/shared'
import { CHECKS_PROMPT, CHECKS_QUESTION, PUSH_PROMPT, REPORT_QUESTION } from './support/fake-question.js'
import { apiData, expect, test } from './support/fixtures.js'
import { boxOf, grid, panelOf } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, lastReply, questionsDrawer, sentToast } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test("an agent's header opens a drawer with only its questions, which takes turns with Files", async ({
  page,
  request,
}) => {
  const pusher = await askingAgent(request, 'Drawer pusher', PUSH_PROMPT)
  const checker = await askingAgent(request, 'Drawer checker', CHECKS_PROMPT)

  await page.goto(`/#agents/${checker.id}`)
  const answer = page.getByRole('button', { name: 'Answer 2 questions' })
  await answer.click()
  const drawer = questionsDrawer(page)
  await expect(drawer).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`#agents/${checker.id}$`))
  await expect(drawer.getByRole('region', { name: /^Questions from / })).toHaveCount(1)
  await expect(agentQuestions(page, checker)).toBeVisible()
  await expect(agentQuestions(page, pusher)).toHaveCount(0)
  await expect(page.getByRole('separator', { name: 'Resize questions' })).toBeVisible()
  const [drawerBox, replyBox] = await Promise.all([boxOf(drawer), boxOf(page.getByRole('combobox', { name: 'Reply' }))])
  expect(drawerBox.x).toBeGreaterThanOrEqual(replyBox.x + replyBox.width)

  const files = page.getByRole('region', { name: 'Files', exact: true })
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await expect(files).toBeVisible()
  await expect(drawer).toHaveCount(0)
  await answer.click()
  await expect(drawer).toBeVisible()
  await expect(files).toHaveCount(0)

  const checks = agentQuestions(page, checker)
  await checks.getByRole('checkbox', { name: /Unit/ }).click()
  await checks.getByRole('textbox', { name: 'Other answer to Report' }).fill('Email me')
  await expect(drawer.getByRole('status')).toHaveText('2 of 2 answered')
  await drawer.getByRole('button', { name: 'Submit', exact: true }).click()

  await expect(drawer).toHaveCount(0)
  await expect(sentToast(page, 'Sent 2 answers. Going on:')).toBeVisible()
  await expect(answer).toHaveCount(0)
  await expect
    .poll(async () => lastReply(request, checker.id))
    .toBe(`Got your answers. ${CHECKS_QUESTION} Unit | ${REPORT_QUESTION} Email me`)

  const needsYou = page.getByRole('main').getByRole('region', { name: 'Needs you' })
  await needsYou.locator(`[data-task-id="${pusher.id}"]`).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${pusher.id}$`))
  await expect(drawer).toBeVisible()
  await agentQuestions(page, pusher).getByRole('button', { name: 'Dismiss Push' }).click()
  await expect(drawer).toHaveCount(0)
  await expect(sentToast(page, 'dismissed 1 question')).toBeVisible()
  expect(await apiData<Question[]>(request, '/questions')).toEqual([])
})

test('the drawer closes itself when the agent has no questions left, however they were settled', async ({
  page,
  request,
}) => {
  const asker = await askingAgent(request, 'Drawer elsewhere', PUSH_PROMPT)
  await page.goto(`/#agents/${asker.id}`)
  await page.getByTestId('question-call').getByRole('button', { name: 'Answer' }).click()
  const drawer = questionsDrawer(page)
  await expect(agentQuestions(page, asker)).toBeVisible()

  const open = await apiData<Question[]>(request, `/questions?task_id=${asker.id}`)
  const response = await request.post('/api/questions/answers', {
    data: { items: open.map((question) => ({ action: 'dismiss', id: question.id })) },
  })
  expect(response.ok(), 'POST /api/questions/answers').toBe(true)
  await expect(drawer).toHaveCount(0, { timeout: 15_000 })
})

test("the grid's compact header opens the drawer in the dock beside the grid", async ({ page, request }) => {
  const asker = await askingAgent(request, 'Grid asker', PUSH_PROMPT)
  await page.goto(`/#agents/${asker.id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const panel = panelOf(page, asker.title)
  await panel.getByRole('button', { name: 'Answer 1 question' }).click()

  const drawer = questionsDrawer(page)
  await expect(drawer).toBeVisible()
  await expect(panel.getByRole('region', { name: 'Agent questions' })).toHaveCount(0)
  const [gridBox, drawerBox] = await Promise.all([boxOf(grid(page)), boxOf(drawer)])
  expect(drawerBox.x).toBeGreaterThan(gridBox.x)
  expect(drawerBox.x + drawerBox.width).toBeLessThanOrEqual(gridBox.x + gridBox.width + 1)

  await drawer.getByRole('radio', { name: 'Yes' }).click()
  await drawer.getByRole('button', { name: 'Submit', exact: true }).click()
  await expect(drawer).toHaveCount(0)
  await expect(sentToast(page, 'Sent 1 answer')).toBeVisible()
})
