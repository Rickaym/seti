import { expect, test } from './support/fixtures.js'
import {
  seedViewTestAgent,
  VIEW_CONSOLE_ERRORS,
  VIEW_HTTP_STATUSES,
  VIEW_VIOLATIONS,
  viewFrame,
  viewModOff,
  viewModOn,
  viewRegion,
} from './support/mod-views.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile } from './support/viewer-files.js'

test.use({
  allowedCspViolations: VIEW_VIOLATIONS,
  allowedConsoleErrors: VIEW_CONSOLE_ERRORS,
  allowedHttpStatuses: VIEW_HTTP_STATUSES,
})

test.beforeEach(async ({ request }) => {
  await viewModOn(request)
})

test.afterEach(async ({ request }) => {
  await viewModOff(request)
})

test("a mod's view fills the phone inside Seti's chrome, and its link asks in Seti's own dialog", async ({ page }) => {
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Board' }).tap()
  const region = viewRegion(page, 'Board')
  await expect(region).toContainText('View test')
  const frame = viewFrame(page, 'Board')
  await expect(frame.locator('#place')).toHaveText('Placed in section on a phone')
  const box = await page.locator('iframe[title="View test: Board"]').boundingBox()
  expect(box?.width).toBe(page.viewportSize()?.width)
  await expectFitsPhone(page, 'a mod view')

  await frame.getByRole('button', { name: 'Save' }).tap()
  await expect(frame.locator('#saved')).toHaveText('Save refused denied')
  await frame.getByRole('button', { name: 'Docs' }).tap()
  const dialog = page.getByRole('dialog', { name: 'Open link' })
  await expect(dialog).toContainText('Open example.test in a new tab?')
  await expectFitsPhone(page, "a mod view's link dialog")
  await dialog.getByRole('button', { name: 'Cancel' }).tap()
  await expect(dialog).toBeHidden()
})

test("a mod's agent tab opens on a phone, and a view for larger screens says so", async ({ page }) => {
  const { id } = await seedViewTestAgent()
  await page.goto(`/#agents/${id}`)
  await tapMoreAction(page, 'Notes')
  const sheet = page.getByRole('dialog', { name: 'Notes' })
  await expect(viewFrame(page, 'Notes').locator('#place')).toHaveText(`Placed in agentTab for ${id} on a phone`)
  await expectFitsPhone(page, 'a mod agent tab')
  await sheet.getByRole('button', { name: 'Close Notes' }).tap()

  await tapMoreAction(page, 'Search Seti')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Open Panel')
  await palette.getByRole('option', { name: /Open Panel/ }).tap()
  const panel = page.getByRole('dialog', { name: 'Panel' })
  await expect(panel.getByRole('status')).toHaveText("View test's Panel view opens on a larger screen.")
  await expect(panel.locator('iframe')).toHaveCount(0)
  await expectFitsPhone(page, 'a mod view for larger screens')
})

test("a mod's file viewer on a phone keeps its resizes within the clamp", async ({ page }) => {
  const { id } = await seedViewTestAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'plan.viewtest')
  const frame = filesPanel(page).frameLocator('iframe[title="View test: View test file"]')
  await expect(frame.locator('#text')).toHaveText('plan.viewtest: SHIP IT\n')
  const element = filesPanel(page).locator('iframe[title="View test: View test file"]')
  await frame.getByRole('button', { name: 'Tiny' }).tap()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(48)
  await frame.getByRole('button', { name: 'Huge' }).tap()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(1600)
  await expectFitsPhone(page, 'a mod file viewer')
})
