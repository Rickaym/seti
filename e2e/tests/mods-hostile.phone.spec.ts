import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixtures.js'
import { fixtureCopy, installFolder, removeMod } from './support/mod-fixtures.js'
import { VIEW_CONSOLE_ERRORS, VIEW_HTTP_STATUSES, VIEW_VIOLATIONS } from './support/mod-views.js'
import { tapMoreAction } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test.use({
  allowedCspViolations: VIEW_VIOLATIONS,
  allowedConsoleErrors: VIEW_CONSOLE_ERRORS,
  allowedHttpStatuses: VIEW_HTTP_STATUSES,
})

const VIEW = 'hostile-view'

test.beforeEach(async ({ request }) => {
  await installFolder(request, fixtureCopy(VIEW))
})

test.afterEach(async ({ request }) => {
  await removeMod(request, VIEW)
})

test("on a phone a hostile view stays inside Seti's chrome and reaches nothing", async ({ page }) => {
  await page.goto(`/#${VIEW}.hostile`)
  const region = page.getByRole('region', { name: 'Hostile view mod: Hostile' })
  await expect(region).toContainText('Hostile view')
  await expect(region).toContainText('mod')
  const frame = page.frameLocator('iframe[title="Hostile view: Hostile"]')
  const results = frame.locator('#out li')
  await expect(results).toHaveCount(17)
  for (const line of ['fetch: blocked', 'popup: blocked', 'top: blocked', 'parent: blocked', 'injected: blocked']) {
    await expect(results.filter({ hasText: new RegExp(`^${line.split(':')[0] ?? ''}:`) })).toHaveText(line)
  }
  const box = await page.locator('iframe[title="Hostile view: Hostile"]').boundingBox()
  expect(box?.width).toBe(page.viewportSize()?.width)
  await expectFitsPhone(page, 'a hostile mod view')
})

test('on a phone a view for larger screens says so, and a viewer keeps its resizes within the clamp', async ({
  page,
}) => {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'probe.hostile'), 'probe\n')
  await page.goto(`/#agents/${id}`)
  await tapMoreAction(page, 'Search Seti')
  const palette = page.getByRole('dialog', { name: 'Search Seti' })
  await palette.getByRole('combobox').fill('>Open Wide')
  await palette.getByRole('option', { name: /Open Wide/ }).tap()
  const panel = page.getByRole('dialog', { name: 'Wide' })
  await expect(panel.getByRole('status')).toHaveText("Hostile view's Wide view opens on a larger screen.")
  await expect(panel.locator('iframe')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'probe.hostile')
  const title = 'Hostile view: Hostile file'
  const frame = filesPanel(page).frameLocator(`iframe[title="${title}"]`)
  await expect(frame.locator('#text')).toHaveText('probe.hostile')
  const element = filesPanel(page).locator(`iframe[title="${title}"]`)
  await frame.getByRole('button', { name: 'Tiny' }).tap()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(48)
  await frame.getByRole('button', { name: 'Huge' }).tap()
  await expect.poll(async () => (await element.boundingBox())?.height).toBe(1600)
  await expectFitsPhone(page, 'a hostile mod file viewer')
})
