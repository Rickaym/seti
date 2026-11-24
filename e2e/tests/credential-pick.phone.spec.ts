import { agentOnCredential, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the credential pick consequence fits a phone', async ({ page, request }) => {
  const { profile } = await agentOnCredential(request, 'Pick on a phone with a long name')
  const id = await insertAgent('default')
  const access = await openAccess(page, id)
  await access.getByRole('switch', { name: 'AWS', exact: true }).tap()
  await access.getByLabel('Credentials').selectOption(profile.id)
  const pick = page.getByRole('dialog', { name: `Use ${profile.name}` })
  await expect(pick).toContainText('Its 1 own choice stays')
  await expectFitsPhone(page, 'credential pick')
  await page.screenshot({ path: test.info().outputPath('pick-phone.png') })
  await pick.getByRole('button', { name: 'Reset own' }).tap()
  await expect(pick).toHaveCount(0)
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
