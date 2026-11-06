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

test("a mod's section view runs in Seti's chrome, follows the theme and reaches only its own storage", async ({
  page,
}) => {
  await page.goto('/#agents')
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name: 'Board' }).click()
  const region = viewRegion(page, 'Board')
  await expect(region).toContainText('View test')
  await expect(region).toContainText('mod')
  const frame = viewFrame(page, 'Board')
  await expect(frame.locator('#place')).toHaveText('Placed in section')
  await expect(frame.locator('#greeting')).toHaveText('Greeting Hello')
  await expect(frame.locator('#refused')).toHaveText('Refused denied')
  const background = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--background').trim(),
  )
  await expect(frame.locator('#theme')).toHaveText(`Theme light ${background}`)

  await frame.getByRole('button', { name: 'Save' }).click()
  await expect(frame.locator('#saved')).toHaveText('Save refused denied')

  await page.evaluate(() => {
    document.documentElement.classList.add('dark')
  })
  await expect(frame.locator('#theme')).toContainText('Theme dark')

  await frame.getByRole('button', { name: 'Docs' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open link' })
  await expect(dialog).toContainText('Open example.test in a new tab?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
})

test("a mod's agent tab opens beside the agent, and its side panel opens from the palette", async ({ page }) => {
  const { id } = await seedViewTestAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Notes' })
  await expect(viewFrame(page, 'Notes').locator('#place')).toHaveText(`Placed in agentTab for ${id}`)
  await sheet.getByRole('button', { name: 'Close Notes' }).click()
  await expect(sheet).toBeHidden()

  await page.keyboard.press('Control+k')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Open Panel')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Panel' })).toBeVisible()
  await expect(viewFrame(page, 'Panel').locator('#place')).toHaveText('Placed in sidePanel')
})

test("a mod's file viewer gets the file once ready, and its resizes stay within the clamp", async ({ page }) => {
  const { id } = await seedViewTestAgent()
  await page.goto(`/#agents/${id}`)
  await page.getByRole('button', { name: 'Files', exact: true }).click()
  await openViewerFile(page, 'plan.viewtest')
  const frame = filesPanel(page).frameLocator('iframe[title="View test: View test file"]')
  await expect(frame.locator('#text')).toHaveText('plan.viewtest: SHIP IT\n')
  const element = filesPanel(page).locator('iframe[title="View test: View test file"]')
  await frame.getByRole('button', { name: 'Huge' }).click()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(1600)
  await frame.getByRole('button', { name: 'Tiny' }).click()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(48)
})
