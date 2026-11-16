import { expect, test } from './support/fixtures.js'
import { openAgentPrs } from './support/phone-agent.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { GONE, LATE, mockLateStatus, seedIdleAgent } from './support/pr-lazy.js'

test('the phone sheet says a status is loading, and shows it once GitHub answered later', async ({ page }) => {
  await mockLateStatus(page, 2)
  const id = await seedIdleAgent('Phone late status', [LATE, GONE])
  await page.goto(`/#agents/${id}`)
  const sheet = await openAgentPrs(page)
  const late = sheet.getByRole('listitem', { name: 'Pull request late#4' })
  await expect(late).toContainText('Loading status')
  await expect(sheet.getByRole('listitem', { name: 'Pull request late#5' })).toContainText('No status from GitHub')
  await expectFitsPhone(page, 'linked PRs while a status loads')
  await expect(late).toContainText('Arrives late', { timeout: 15_000 })
  await expect(late).not.toContainText('Loading status')
  await page.request.delete(`/api/tasks/${id}`)
})
