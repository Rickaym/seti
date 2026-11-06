import { expect, test, unique } from './support/fixtures.js'
import { boxOf, grid, items, mainGrid, panelOf, rectOf, startAgent, status, toolbar } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

test('a template fills each screen up to its most, evening out a short screen, and Tidy keeps to it', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  const titles = [1, 2, 3, 4, 5].map((n) => unique(`Grid template ${String(n)}`))
  const ids: string[] = []
  for (const title of titles) {
    ids.push(await startAgent(request, title))
  }
  await page.goto(`/#agents/${ids[0] ?? ''}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  const bar = toolbar(page)
  await bar.getByRole('button', { name: /^Panels per screen/ }).click()
  await page.getByRole('menuitemradio', { name: 'Up to 3 per screen' }).click()
  await expect(status(page)).toHaveText('Grid holds up to 3 panels a screen')
  await expect(bar.getByRole('button', { name: 'Panels per screen: Up to 3 per screen' })).toBeVisible()
  for (const [index, id] of ids.slice(1).entries()) {
    await page.goto(`/#agents/${id}`)
    await expect(items(page)).toHaveCount(index + 2)
  }
  await expect(panelOf(page, titles[4] ?? '')).toBeInViewport()
  await expect.poll(async () => rectOf(panelOf(page, titles[3] ?? ''))).toEqual([0, 24, 6, 24])

  await bar.getByRole('button', { name: 'Tidy', exact: true }).click()
  await expect(status(page)).toHaveText('Tidied 5 panels up to 3 to a screen')
  const rects = await Promise.all(titles.map(async (title) => rectOf(panelOf(page, title))))
  expect(rects).toEqual([
    [0, 0, 4, 24],
    [4, 0, 4, 24],
    [8, 0, 4, 24],
    [0, 24, 6, 24],
    [6, 24, 6, 24],
  ])
  const screen = await grid(page).evaluate((element) => element.clientHeight)
  const [first, fourth] = await Promise.all([
    boxOf(panelOf(page, titles[0] ?? '')),
    boxOf(panelOf(page, titles[3] ?? '')),
  ])
  expect(Math.abs(fourth.y - first.y - screen)).toBeLessThanOrEqual(10)
  await expect.poll(async () => (await mainGrid(request))?.layout.perScreen).toBe(3)

  await page.reload()
  await expect(toolbar(page).getByRole('button', { name: 'Panels per screen: Up to 3 per screen' })).toBeVisible()
  await expect.poll(async () => rectOf(panelOf(page, titles[4] ?? ''))).toEqual([6, 24, 6, 24])
})
