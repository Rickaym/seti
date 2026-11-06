import { expect, test } from './support/fixtures.js'
import { eaReads, seedDirect } from './support/team-direct.js'

test('a direct message shows on a phone with its recipient, and the filter hides it', async ({ page, request }) => {
  const seed = await seedDirect()
  await page.goto('/#agents')
  await page.getByRole('banner').getByTestId('team-chat-toggle').tap()
  const sheet = page.getByRole('dialog', { name: 'Group chat' })
  const direct = sheet.getByTestId('team-message').filter({ hasText: seed.secret })
  await expect(direct.getByTestId('team-direct')).toHaveText(`@${seed.to}`)
  const toggle = sheet.getByRole('button', { name: 'Direct messages' })
  await toggle.tap()
  await expect(direct).toHaveCount(0)
  await expect(sheet.getByText(seed.open)).toBeVisible()
  await toggle.tap()
  await expect(direct).toBeVisible()
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(scroll).toBe(0)
  expect(await eaReads(request)).not.toContain(seed.secret)
})
