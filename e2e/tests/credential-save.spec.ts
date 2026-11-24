import { agentOnCredential, insertAgent, openAccess } from './support/credential-access.js'
import { expect, test } from './support/fixtures.js'

test("Save access copies an agent's access into its credential after a preview", async ({ page, request }) => {
  const { id, profile } = await agentOnCredential(request, 'Save')
  await insertAgent(profile.id)
  const access = await openAccess(page, id)
  const aws = access.getByRole('switch', { name: 'AWS', exact: true })
  const row = access.getByRole('listitem').filter({ has: aws })
  await aws.click()
  await expect(row).toContainText('Custom')

  await access.getByRole('button', { name: 'Save access' }).click()
  const save = page.getByRole('dialog', { name: `Save access to ${profile.name}` })
  await expect(save).toContainText(`1 other agent uses ${profile.name}`)
  await expect(save.getByRole('list', { name: 'What changes' })).toContainText('Turns AWS off for 1 agent: E2E follows')
  await expect(save).toContainText('1 own choice is cleared')
  await page.screenshot({ path: test.info().outputPath('save-preview.png') })
  await save.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText(`Saved to ${profile.name}; its agents follow it from their next turn`)).toBeVisible()
  await expect(save).toHaveCount(0)
  await expect(row).toContainText('Credential')
  await expect(aws).not.toBeChecked()
  await request.delete(`/api/credentials/profiles/${profile.id}`)
})
