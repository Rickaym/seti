import { expect, test, toasts } from './support/fixtures.js'
import {
  CAUGHT_CRASH,
  contextHeading,
  loseContextChunk,
  openContextFromAgents,
  RAW_MESSAGE,
  reportPreloadError,
} from './support/stale-build.js'

test.use({ allowedConsoleErrors: [CAUGHT_CRASH], allowedHttpStatuses: [404] })

test('a panel whose file a deploy replaced reloads the page once and then shows', async ({ page }) => {
  const build = await loseContextChunk(page, 1)
  await openContextFromAgents(page)

  await expect(contextHeading(page)).toBeVisible()
  expect(build.loads()).toBe(2)
  expect(build.asked()).toBe(2)
  await expect(page).toHaveURL(/#context$/)
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0)
})

test('a panel that still fails after the reload offers Reload instead of the raw error', async ({ page }) => {
  const build = await loseContextChunk(page, Number.POSITIVE_INFINITY)
  await openContextFromAgents(page)

  const alert = page.getByRole('main').getByRole('alert')
  await expect(alert).toContainText('Context could not be shown.')
  await expect(alert).toContainText('usually because Seti was updated')
  await expect(alert.getByText(RAW_MESSAGE)).toBeHidden()
  expect(build.loads()).toBe(2)
  await expect(page.getByRole('contentinfo')).toBeVisible()

  build.serve()
  const reload = alert.getByRole('button', { name: 'Reload', exact: true })
  await expect(reload).toHaveAttribute('title', /current version of Seti/)
  await reload.click()
  await expect(contextHeading(page)).toBeVisible()
  expect(build.loads()).toBe(3)
  await expect(page).toHaveURL(/#context$/)
})

test('unsaved changes keep the page and get a New version notice with Reload', async ({ page }) => {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  await page.goto('/#settings/general')
  const name = page.getByRole('textbox', { name: 'Your name' })
  await name.fill('Unsaved name')
  await reportPreloadError(page)

  const notice = toasts(page).filter({ hasText: 'New version' })
  await expect(notice).toContainText('Save your changes, then reload')
  await expect(notice.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(name).toHaveValue('Unsaved name')
  expect(loads).toBe(1)
})
