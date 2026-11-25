import { agentOnCredential, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'
import { coveredDialog, expectCovered, expectOnTop, failAccessChange, shootSchemes } from './support/stacking.js'

test.use({ allowedHttpStatuses: [500] })

test('a confirm dims the dialog it opens from, and Esc closes only the confirm', async ({ page }) => {
  const access = await openAccess(page, await insertAgent('default'))
  await access.getByRole('switch', { name: 'AWS', exact: true }).click()
  await access.getByRole('button', { name: 'Reset all' }).click()
  const confirm = page.getByRole('dialog', { name: 'Reset access' })
  await expect(confirm).toBeVisible()
  await shootSchemes(page, 'confirm-over-access')
  await expectCovered(coveredDialog(page, /^Access of /), confirm)

  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(access).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(access).toHaveCount(0)
})

test('a nested dialog dims the dialog under it, and its tooltips and failure toasts show above it', async ({
  page,
  request,
}) => {
  const { profile } = await agentOnCredential(request, 'Nested')
  const access = await openAccess(page, await insertAgent('default'))

  await access.getByRole('button', { name: 'About SSH hosts' }).hover()
  const tip = page.locator('[data-slot=tooltip-content]')
  await expect(tip).toBeVisible()
  await expectOnTop(tip)
  await page.mouse.move(0, 0)
  await expect(tip).toHaveCount(0)

  await access.getByRole('combobox', { name: 'Credentials', exact: true }).selectOption(profile.id)
  const pick = page.getByRole('dialog', { name: `Use ${profile.name}` })
  await expect(pick).toBeVisible()
  await shootSchemes(page, 'pick-over-access')
  await expectCovered(coveredDialog(page, /^Access of /), pick)

  await page.keyboard.press('Escape')
  await expect(pick).toHaveCount(0)
  await expect(access).toBeVisible()

  await failAccessChange(page)
  await access.getByRole('switch', { name: 'AWS', exact: true }).click()
  const failure = page.locator('[data-sonner-toast]').filter({ hasText: 'Access store unavailable' })
  await expect(failure).toBeVisible()
  await expectOnTop(failure)
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
