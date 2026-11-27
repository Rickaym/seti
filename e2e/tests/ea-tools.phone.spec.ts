import { fakeEaTools } from './support/ea-tools.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the EA tool list stays short on a phone, opens an area on a tap and searches', async ({ page }) => {
  await fakeEaTools(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Tools' })
  await expect(card.getByTestId('ea-tools-count')).toHaveText('5 tools; 2 ask first; 1 on your word')
  await expect(card.getByRole('listitem')).toHaveCount(0)
  expect((await card.boundingBox())?.height).toBeLessThan(900)
  const channels = card.getByRole('button', { name: /^Channels/ })
  await channels.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'EA tool list')
  await channels.tap()
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card.getByRole('listitem')).toContainText('Asks first')
  const search = card.getByRole('searchbox', { name: 'Search tools' })
  await search.tap()
  await search.fill('stop')
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card.getByRole('listitem')).toContainText('stop_task')
  await expectFitsPhone(page, 'EA tool list searched')
})
