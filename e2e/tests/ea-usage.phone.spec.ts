import { seedEaUsage } from './support/ea-usage.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the EA cost and speed fit a phone', async ({ page }) => {
  await seedEaUsage()
  await page.goto('/#settings/ea')
  const card = page.getByRole('region', { name: 'Cost and speed' })
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByRole('button', { name: 'First token: 0.9 s, p95 1.3 s' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Calls: 4 today, 5 in 7 days' })).toBeVisible()
  await expect(card.getByText('4 today')).toBeInViewport()
  await expectFitsPhone(page, 'EA cost and speed')
})
