import { clearEaUsage, seedEaUsage } from './support/ea-usage.js'
import { expect, test } from './support/fixtures.js'

test('the EA settings show what its model calls cost and how fast they answered', async ({ page }) => {
  await clearEaUsage()
  await page.goto('/#settings/ea')
  const card = page.getByRole('region', { name: 'Cost and speed' })
  await expect(card).toContainText('No EA model calls in the last week yet.')

  await seedEaUsage()
  await card.getByRole('button', { name: 'Refresh' }).click()
  await expect(card.getByRole('button', { name: 'First token: 0.9 s, p95 1.3 s' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Input: 16.0k, 60 out' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Cached: 50%, of input' })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Calls: 4 today, 5 in 7 days' })).toBeVisible()
  await expect(card).toContainText('Speech to text 0.3 s, text to speech 0.2 s, medians on calls')

  await card.getByRole('button', { name: /^Calls:/ }).hover()
  await expect(page.getByRole('tooltip')).toContainText('3 on calls, 1 in chat, 1 for inbox reports, with 5 tool calls')
})
