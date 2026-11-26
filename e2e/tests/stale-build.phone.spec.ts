import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'
import {
  CAUGHT_CRASH,
  contextHeading,
  loseContextChunk,
  openContextFromAgents,
  RAW_MESSAGE,
  reportPreloadError,
} from './support/stale-build.js'

test.use({ allowedConsoleErrors: [CAUGHT_CRASH], allowedHttpStatuses: [404] })

test('a phone reloads the page once for a panel whose file a deploy replaced', async ({ page }) => {
  const build = await loseContextChunk(page, 1)
  await openContextFromAgents(page)

  await expect(contextHeading(page)).toBeVisible()
  expect(build.loads()).toBe(2)
  await expect(page).toHaveURL(/#context$/)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
})

test('a phone gets a Reload it can tap when the panel still fails after the reload', async ({ page }) => {
  const build = await loseContextChunk(page, Number.POSITIVE_INFINITY)
  await openContextFromAgents(page)

  const alert = page.getByRole('main').getByRole('alert')
  await expect(alert).toContainText('Context could not be shown.')
  await expect(alert.getByText(RAW_MESSAGE)).toBeHidden()
  expect(build.loads()).toBe(2)
  const reload = alert.getByRole('button', { name: 'Reload', exact: true })
  expect((await reload.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40)
  await expectFitsPhone(page, 'stale build')

  build.serve()
  await reload.tap()
  await expect(contextHeading(page)).toBeVisible()
  expect(build.loads()).toBe(3)
})

test('a phone with unsaved changes keeps the page and offers Update', async ({ page }) => {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.goto('/#settings/general')
  const name = page.getByRole('textbox', { name: 'Your name' })
  await name.fill('Unsaved name')
  await reportPreloadError(page)

  await name.blur()
  await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Update', exact: true })).toBeVisible()
  await expect(name).toHaveValue('Unsaved name')
  expect(loads).toBe(1)
  await expectFitsPhone(page, 'Update in the status bar')
})
