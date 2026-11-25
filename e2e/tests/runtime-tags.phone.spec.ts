import { codexOff, codexReady } from './support/codex.js'
import { expect, test } from './support/fixtures.js'
import { mockTaggedServers } from './support/runtime-tags.js'

test.afterEach(async ({ request }) => {
  await codexOff(request)
})

test('on a phone, a server Codex cannot use says Claude only and the row fits', async ({ page, request }) => {
  await codexReady(request)
  await mockTaggedServers(page)
  await page.goto('/#settings/mcp')
  const main = page.getByRole('main')
  const events = main.getByRole('listitem').filter({ hasText: 'events' })
  await expect(events.getByText('Claude only')).toBeVisible()
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(width, 'no horizontal page scroll').toBeLessThanOrEqual(0)
})
