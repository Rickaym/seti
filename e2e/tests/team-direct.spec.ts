import { expect, test } from './support/fixtures.js'
import { eaReads, seedDirect } from './support/team-direct.js'

test('a direct message shows in the group chat with its recipient, and the filter hides it', async ({
  page,
  request,
}) => {
  const seed = await seedDirect()
  await page.goto('/#agents')
  await page.keyboard.press('Control+Shift+L')
  const panel = page.getByRole('complementary', { name: 'Group chat' })
  const direct = panel.getByTestId('team-message').filter({ hasText: seed.secret })
  await expect(direct).toHaveAttribute('data-direct', 'true')
  await expect(direct.getByTestId('team-direct')).toHaveText(`@${seed.to}`)
  await expect(direct.getByLabel(`Direct message to @${seed.to}`)).toBeVisible()
  const toggle = panel.getByRole('button', { name: 'Direct messages' })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(direct).toHaveCount(0)
  await expect(panel.getByText(seed.open)).toBeVisible()
  await toggle.click()
  await expect(direct).toBeVisible()
  const ea = await eaReads(request)
  expect(ea).toContain(seed.open)
  expect(ea).not.toContain(seed.secret)
})
