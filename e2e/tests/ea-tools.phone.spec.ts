import { fakeEaTools } from './support/ea-tools.js'
import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('the EA tool list fits a phone and searches from the keyboard', async ({ page }) => {
  await fakeEaTools(page)
  await page.goto('/#settings/ea')
  const card = page.getByRole('main').getByRole('region', { name: 'Tools' })
  await expect(card.getByTestId('ea-tools-count')).toHaveText('5 tools; 2 ask first; 1 on your word')
  const search = card.getByRole('searchbox', { name: 'Search tools' })
  await search.scrollIntoViewIfNeeded()
  await expectFitsPhone(page, 'EA tool list')
  await search.tap()
  await search.fill('channel')
  await expect(card.getByRole('listitem')).toHaveCount(1)
  await expect(card.getByRole('listitem')).toContainText('Asks first')
  await expectFitsPhone(page, 'EA tool list searched')
})
