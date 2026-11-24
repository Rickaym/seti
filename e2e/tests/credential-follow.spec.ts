import { agentOnCredential, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'

test("an agent's rows say what comes from its credential, and Reset all follows it again", async ({
  page,
  request,
}) => {
  const { id, profile } = await agentOnCredential(request, 'Follow')
  const access = await openAccess(page, id)
  const aws = access.getByRole('switch', { name: 'AWS', exact: true })
  const row = access.getByRole('listitem').filter({ has: aws })
  await expect(row).toContainText('Credential')
  await expect(aws).toBeChecked()
  await expect(access.getByRole('button', { name: 'Reset all' })).toBeDisabled()

  await aws.click()
  await expect(row).toContainText('Custom')
  await expect(aws).not.toBeChecked()
  await page.screenshot({ path: test.info().outputPath('agent-marks.png') })
  await access.getByRole('button', { name: 'Reset all' }).click()
  const confirm = page.getByRole('dialog', { name: 'Reset access' })
  await expect(confirm).toContainText(`follows ${profile.name}`)
  await confirm.getByRole('button', { name: 'Reset' }).click()
  await expect(row).toContainText('Credential')
  await expect(aws).toBeChecked()
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
