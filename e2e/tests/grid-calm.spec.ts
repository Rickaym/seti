import type { Page } from '@playwright/test'
import { CHECKS_PROMPT, CHECKS_QUESTION, REPORT_QUESTION } from './support/fake-question.js'
import { expect, test, unique } from './support/fixtures.js'
import { boxOf, focusedPanel, grid, panelOf, rectOf, startAgent, toolbar } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { agentQuestions, askingAgent, requestsDrawer } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV, calmGrid: true })

const reply = (page: Page, title: string) => panelOf(page, title).getByRole('combobox', { name: 'Reply' })
const transcript = (page: Page, title: string) => panelOf(page, title).getByRole('region', { name: 'Transcript' })
const outcome = (page: Page, title: string) => panelOf(page, title).getByTestId('calm-outcome')
const calm = (page: Page, title: string) => panelOf(page, title).locator('[data-grid-calm="true"]')
const calmToggle = (page: Page) => toolbar(page).getByRole('button', { name: 'Calm', exact: true })

/** Puts two agents side by side, the first on the left, with the right one in use. */
async function sideBySide(page: Page, ids: { left: string; right: string }) {
  await page.goto(`/#agents/${ids.left}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect(page.locator('[data-grid-item]')).toHaveCount(1)
  await page.goto(`/#agents/${ids.right}`)
  await expect(page.locator('[data-grid-item]')).toHaveCount(2)
}

test('calm panels show the latest message and open on a click, a key or the toggle', async ({ page, request }) => {
  test.setTimeout(60_000)
  const left = unique('Calm left')
  const right = unique('Calm right')
  const ids = { left: await startAgent(request, left), right: await startAgent(request, right) }
  await sideBySide(page, ids)

  await expect(calmToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(calm(page, left)).toHaveCount(1)
  await expect(outcome(page, left)).toContainText('Done.')
  await expect(reply(page, left)).toHaveCount(0)
  await expect(transcript(page, left)).toHaveCount(0)
  await expect(panelOf(page, left).getByTestId('own-message-nav')).toHaveCount(0)
  await expect(reply(page, right)).toBeVisible()
  await expect(transcript(page, right)).toBeVisible()

  await outcome(page, left).click()
  await expect(reply(page, left)).toBeVisible()
  await expect(transcript(page, left)).toBeVisible()
  await expect(calm(page, right)).toHaveCount(1)
  await expect(reply(page, right)).toHaveCount(0)

  await reply(page, left).click()
  await page.keyboard.press('Escape')
  await expect(calm(page, left)).toHaveCount(1)
  await expect(reply(page, left)).toHaveCount(0)
  await expect(focusedPanel(page).getByRole('heading', { name: left })).toBeVisible()

  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([6, 0, 6, 24])
  await expect(calm(page, left)).toHaveCount(1)

  await panelOf(page, right).getByRole('button', { name: 'More actions' }).focus()
  await expect(reply(page, right)).toBeVisible()
  await expect(calm(page, left)).toHaveCount(1)

  await calmToggle(page).click()
  await expect(reply(page, left)).toBeVisible()
  await expect(reply(page, right)).toBeVisible()
  await page.reload()
  await expect(calmToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await expect(reply(page, left)).toBeVisible()
  await calmToggle(page).click()
  await expect(reply(page, left)).toHaveCount(0)
  await expect(reply(page, right)).toHaveCount(0)
})

test('a calm panel shows a waiting question in full, and its Answer works on the first press', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const asker = await askingAgent(request, 'Calm asker', CHECKS_PROMPT)
  const other = unique('Calm other')
  await sideBySide(page, { left: asker.id, right: await startAgent(request, other) })

  await expect(calm(page, asker.title)).toHaveCount(1)
  const card = panelOf(page, asker.title).getByTestId('question-call')
  for (const question of [CHECKS_QUESTION, REPORT_QUESTION]) {
    await expect(card.getByText(question)).toBeInViewport({ ratio: 1 })
  }
  const [cardBox, panelBox] = await Promise.all([boxOf(card), boxOf(panelOf(page, asker.title))])
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(panelBox.y + panelBox.height)
  await expect(panelOf(page, asker.title).getByTestId('status-line')).toContainText('Asks')

  await card.getByRole('button', { name: 'Answer' }).click()
  await expect(requestsDrawer(page)).toBeVisible()
  for (const header of ['Checks', 'Report']) {
    await agentQuestions(page, asker)
      .getByRole('button', { name: `Dismiss ${header}` })
      .click()
  }
  await expect(requestsDrawer(page)).toHaveCount(0)
})

test('the List toggle hides the agents list beside the grid and brings it back', async ({ page, request }) => {
  const title = unique('Calm list')
  const id = await startAgent(request, title)
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const list = page.getByRole('heading', { name: 'Agents', level: 1 })
  const toggle = toolbar(page).getByRole('button', { name: 'List', exact: true })
  await expect(list).toBeVisible()
  const before = await boxOf(grid(page))

  await toggle.click()
  await expect(list).toBeHidden()
  expect((await boxOf(grid(page))).width).toBeGreaterThan(before.width)
  await page.reload()
  await expect(grid(page)).toBeVisible()
  await expect(list).toBeHidden()

  await toggle.click()
  await expect(list).toBeVisible()
})
