import { agentOnCredential, awsRow, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone, expectTouchTarget } from './support/phone-layout.js'

test("the access dialog's marks and Reset all fit a phone", async ({ page, request }) => {
  const { id, profile } = await agentOnCredential(request, 'Follow on a long phone name')
  const access = await openAccess(page, id)
  const aws = access.getByRole('switch', { name: 'AWS', exact: true })
  await aws.tap()
  await expect(awsRow(page, access)).toContainText('Custom')
  await expectFitsPhone(page, 'access dialog')
  await expectTouchTarget(access.getByRole('button', { name: 'Reset all' }))
  await page.screenshot({ path: test.info().outputPath('agent-marks-phone.png') })
  await access.getByRole('button', { name: 'Reset all' }).tap()
  await page.getByRole('dialog', { name: 'Reset access' }).getByRole('button', { name: 'Reset' }).tap()
  await expect(aws).toBeChecked()
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
