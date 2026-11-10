import type { Page } from '@playwright/test'
import { expect, test, unique } from './support/fixtures.js'
import { focusedPanel, grid, panelOf, rectOf, startAgent, status, toolbar } from './support/grid.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'

test.use({ serverEnv: FAKE_CLAUDE_ENV })

const palette = (page: Page) => page.getByRole('dialog', { name: 'Search Seti' })

test('an agent opened from the palette below the fold scrolls into view and takes focus the first time', async ({
  page,
  request,
}) => {
  test.setTimeout(60_000)
  const left = unique('Grid reveal left')
  const right = unique('Grid reveal right')
  const leftId = await startAgent(request, left)
  const rightId = await startAgent(request, right)
  await page.goto(`/#agents/${leftId}`)
  await page.getByRole('button', { name: 'Open in grid' }).click()
  await expect.poll(async () => rectOf(panelOf(page, left))).toEqual([0, 0, 12, 24])
  await toolbar(page)
    .getByRole('button', { name: /^Panels per screen/ })
    .click()
  await page.getByRole('menuitemradio', { name: 'Up to 2 per screen' }).click()
  await expect(status(page)).toHaveText('Grid holds up to 2 panels a screen')
  await page.goto(`/#agents/${rightId}`)
  await expect.poll(async () => rectOf(panelOf(page, right))).toEqual([6, 0, 6, 24])
  await panelOf(page, right).getByRole('combobox', { name: 'Reply' }).click()

  const below = unique('Grid reveal below')
  const belowId = await startAgent(request, below)
  await page.keyboard.press('Control+k')
  await palette(page).getByRole('combobox').fill(below)
  await expect(palette(page).getByRole('option', { name: new RegExp(below) })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(palette(page)).toBeHidden()

  await expect.poll(async () => rectOf(panelOf(page, below))).toEqual([0, 24, 12, 24])
  await expect(panelOf(page, below)).toBeInViewport()
  await expect(panelOf(page, left)).not.toBeInViewport()
  expect(await grid(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(page).toHaveURL(new RegExp(`#agents/${belowId}$`))
  await expect(focusedPanel(page).getByRole('heading', { name: below })).toBeVisible()
  await expect(panelOf(page, below).getByRole('combobox', { name: 'Reply' })).toBeFocused()
})
