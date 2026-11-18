import { CHECKS_PROMPT, CHECKS_QUESTION, REPORT_QUESTION } from './support/fake-question.js'
import { expect, test, unique } from './support/fixtures.js'
import { boxOf, grid, panelOf, startAgent, toolbar } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { askingAgent } from './support/questions.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('grid panels show their transcripts and reply boxes, with no Calm toggle', async ({ page, request }) => {
  const left = unique('Full left')
  const right = unique('Full right')
  const ids = { left: await startAgent(request, left), right: await startAgent(request, right) }
  await page.addInitScript(() => {
    localStorage.setItem('seti.agents.grid.prefs', JSON.stringify({ calm: true, listHidden: false }))
  })
  await page.goto(`/#agents/${ids.left}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect(page.locator('[data-grid-item]')).toHaveCount(1)
  await page.goto(`/#agents/${ids.right}`)
  await expect(page.locator('[data-grid-item]')).toHaveCount(2)

  for (const title of [left, right]) {
    await expect(panelOf(page, title).getByRole('region', { name: 'Transcript' })).toBeVisible()
    await expect(panelOf(page, title).getByRole('combobox', { name: 'Reply' })).toBeVisible()
  }
  await expect(toolbar(page).getByRole('button', { name: 'Calm', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Agents', level: 1 })).toBeVisible()
})

test('a question in a grid panel wraps inside the panel', async ({ page, request }) => {
  test.setTimeout(60_000)
  const asker = await askingAgent(request, 'Grid asker', CHECKS_PROMPT)
  await page.goto(`/#agents/${asker.id}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect(page.locator('[data-grid-item]')).toHaveCount(1)
  await page.goto(`/#agents/${await startAgent(request, unique('Grid other'))}`)
  await expect(page.locator('[data-grid-item]')).toHaveCount(2)

  const card = panelOf(page, asker.title).getByTestId('question-call')
  for (const question of [CHECKS_QUESTION, REPORT_QUESTION]) {
    await expect(card.getByText(question)).toBeVisible()
  }
  const [cardBox, panelBox] = await Promise.all([boxOf(card), boxOf(panelOf(page, asker.title))])
  expect(cardBox.x).toBeGreaterThanOrEqual(panelBox.x)
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(panelBox.x + panelBox.width)
})

test('the List toggle hides the agents list beside the grid and brings it back', async ({ page, request }) => {
  const title = unique('Grid list')
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
