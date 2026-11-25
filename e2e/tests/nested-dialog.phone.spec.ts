import { agentOnCredential, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'
import { coveredDialog, expectCovered, expectOnTop, failAccessChange, shootSchemes } from './support/stacking.js'

test.use({ allowedHttpStatuses: [500] })

test('on a phone a confirm dims the dialog it opens from', async ({ page }) => {
  const access = await openAccess(page, await insertAgent('default'))
  await access.getByRole('switch', { name: 'AWS', exact: true }).tap()
  await access.getByRole('button', { name: 'Reset all' }).tap()
  const confirm = page.getByRole('dialog', { name: 'Reset access' })
  await expect(confirm).toBeVisible()
  await shootSchemes(page, 'confirm-over-access-phone')
  await expectCovered(coveredDialog(page, /^Access of /), confirm)

  await confirm.getByRole('button', { name: 'Cancel' }).tap()
  await expect(confirm).toHaveCount(0)
  await expect(access).toBeVisible()
})

test('on a phone a nested dialog dims the dialog under it, and its popovers and toasts show above it', async ({
  page,
  request,
}) => {
  const { profile } = await agentOnCredential(request, 'Nested phone')
  const access = await openAccess(page, await insertAgent('default'))

  await access.getByRole('button', { name: 'About SSH hosts' }).tap()
  const about = page.locator('[data-slot=popover-content]')
  await expect(about).toBeVisible()
  await expectOnTop(about)
  await page.keyboard.press('Escape')
  await expect(about).toHaveCount(0)
  await expect(access).toBeVisible()

  await access.getByRole('combobox', { name: 'Credentials', exact: true }).selectOption(profile.id)
  const pick = page.getByRole('dialog', { name: `Use ${profile.name}` })
  await expect(pick).toBeVisible()
  await shootSchemes(page, 'pick-over-access-phone')
  await expectCovered(coveredDialog(page, /^Access of /), pick)
  await pick.getByRole('button', { name: 'Cancel' }).tap()
  await expect(pick).toHaveCount(0)

  await failAccessChange(page)
  await access.getByRole('switch', { name: 'AWS', exact: true }).tap()
  const failure = page.locator('[data-sonner-toast]').filter({ hasText: 'Access store unavailable' })
  await expect(failure).toBeVisible()
  await expectOnTop(failure)
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
