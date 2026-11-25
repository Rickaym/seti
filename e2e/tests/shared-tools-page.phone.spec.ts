import { expect, test } from './support/fixtures.js'
import { expectFitsPhone } from './support/phone-layout.js'

test('a phone opens Shared tools from the Capabilities group', async ({ page }) => {
  await page.goto('/#settings')
  const group = page
    .getByRole('main')
    .getByRole('navigation', { name: 'Settings pages' })
    .getByRole('group', { name: 'Capabilities' })
  await group.getByRole('button', { name: 'Shared tools' }).tap()
  await expect(page).toHaveURL(/#settings\/tools$/)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Shared tools', level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'Shared tools page')
})
