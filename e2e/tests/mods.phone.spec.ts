import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from './support/fixtures.js'
import { resetSampleMod, sampleToggle, setModEnabled } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { filesPanel, openViewerFile, seedViewerAgent } from './support/viewer-files.js'

test.afterEach(async ({ request }) => {
  await resetSampleMod(request)
})

test('the phone lists mods, turns one on, opens its section and settings, and turns it off', async ({ page }) => {
  await page.goto('/#settings')
  const main = page.getByRole('main')
  await main.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Mods' }).click()
  await expect(main.getByRole('heading', { name: 'Mods', level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'mods settings')

  await sampleToggle(page).scrollIntoViewIfNeeded()
  await sampleToggle(page).click()
  await expect(sampleToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await main.getByRole('button', { name: 'Open Sample' }).click()
  await expect(main.getByRole('heading', { name: 'Sample', level: 2 })).toBeVisible()
  await main.getByRole('tab', { name: 'Settings' }).click()
  await expect(main.getByRole('textbox', { name: 'Greeting' })).toHaveValue('Hello')
  await expectFitsPhone(page, "a mod's settings tab")

  await page.getByRole('button', { name: 'Menu' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Sample' }).click()
  await expect(main.getByText('Hello')).toBeVisible()
  await expectFitsPhone(page, 'a mod section')

  await page.goto('/#settings/mods')
  await sampleToggle(page).click()
  await expect(sampleToggle(page)).toHaveAttribute('aria-pressed', 'false')
  await page.getByRole('button', { name: 'Menu' }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Sample' })).toHaveCount(0)
})

test("the phone shows a mod's file viewer, and offers to turn the mod on while it is off", async ({
  page,
  request,
}) => {
  const { id, dir } = await seedViewerAgent(10)
  fs.writeFileSync(path.join(dir, 'docs', 'plan.samplenote'), 'ship it\n')
  await page.goto(`/#agents/${id}`)
  await page.getByRole('main').getByRole('button', { name: 'More actions' }).tap()
  await page.getByRole('dialog', { name: 'Agent actions' }).getByRole('button', { name: 'Files' }).tap()
  await openViewerFile(page, 'plan.samplenote')
  const panel = filesPanel(page)
  await expect(panel.getByText('ship it', { exact: true })).toBeVisible()
  const note = panel.getByRole('note').filter({ hasText: 'Sample shows these files.' })
  await expect(note).toBeVisible()
  await expectFitsPhone(page, 'a file a mod that is off would show')

  await note.getByRole('button', { name: 'Turn on' }).tap()
  await expect(panel.getByText('Sample notes: plan.samplenote')).toBeVisible()
  await expect(panel.getByText('SHIP IT', { exact: true })).toBeVisible()
  await expectFitsPhone(page, "a mod's file viewer")
  await setModEnabled(request, 'sample', false)
})
