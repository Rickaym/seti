import { agentOnCredential, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test('the Save access preview fits a phone', async ({ page, request }) => {
  const { id, profile } = await agentOnCredential(request, 'Save on a phone with a long name')
  await insertAgent(profile.id)
  await insertAgent(profile.id)
  const access = await openAccess(page, id)
  await access.getByRole('switch', { name: 'AWS', exact: true }).tap()
  await expectTouchTarget(access.getByRole('button', { name: 'Save access' }))
  await access.getByRole('button', { name: 'Save access' }).tap()
  const save = page.getByRole('dialog', { name: `Save access to ${profile.name}` })
  await expect(save).toContainText('Turns AWS off for 2 agents')
  await expectFitsPhone(page, 'save preview')
  await page.screenshot({ path: test.info().outputPath('save-preview-phone.png') })
  await save.getByRole('button', { name: 'Save' }).tap()
  await expect(save).toHaveCount(0)
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
