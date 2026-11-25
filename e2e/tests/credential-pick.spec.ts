import { agentOnCredential, awsRow, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'

test('picking a credential with an access set says what the agent follows, and can reset', async ({
  page,
  request,
}) => {
  const { profile } = await agentOnCredential(request, 'Pick')
  const id = await insertAgent('default')
  const access = await openAccess(page, id)
  const aws = access.getByRole('switch', { name: 'AWS', exact: true })
  await aws.click()
  await expect(awsRow(page, access)).toContainText('Custom')
  await aws.click()
  await expect(awsRow(page, access)).toContainText('Inherited')
  await access.getByRole('combobox', { name: 'Credentials', exact: true }).selectOption(profile.id)
  const pick = page.getByRole('dialog', { name: `Use ${profile.name}` })
  await expect(pick).toContainText('follows')
  await expect(pick).toContainText('Turns on: AWS')
  await page.screenshot({ path: test.info().outputPath('pick.png') })
  await pick.getByRole('button', { name: 'Switch' }).click()
  await expect(pick).toHaveCount(0)
  await expect(awsRow(page, access)).toContainText('Credential')
  await expect(aws).toBeChecked()
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
