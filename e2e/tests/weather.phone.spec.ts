import { expect, test } from './support/fixtures.js'
import { modToggle } from './support/mods.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { band, mockWeather, NOW, resetWeatherMod } from './support/weather.js'

test.afterEach(async ({ request }) => {
  await resetWeatherMod(request)
})

test('on a phone the Weather mod draws the band, sets it up, and turns off and on again', async ({ page }) => {
  await mockWeather(page)
  await page.clock.setFixedTime(NOW)
  await page.goto('/#settings')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 14 C$/)
  const main = page.getByRole('main')
  const nav = main.getByRole('navigation', { name: 'Settings pages' })

  await nav.getByRole('button', { name: 'Weather' }).click()
  await expect(main.getByRole('heading', { name: 'Weather', level: 2 })).toBeVisible()
  await main.getByRole('combobox', { name: 'Units' }).selectOption('Fahrenheit')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 56 F$/)
  await expectFitsPhone(page, 'the Weather settings')

  await page.goto('/#settings/mods')
  await modToggle(page, 'Weather').scrollIntoViewIfNeeded()
  await modToggle(page, 'Weather').click()
  await expect(modToggle(page, 'Weather')).toHaveAttribute('aria-pressed', 'false')
  await expect(band(page)).toHaveCount(0)
  await expect(page.getByRole('banner').getByRole('button', { name: 'Menu' })).toBeVisible()

  await modToggle(page, 'Weather').click()
  await expect(band(page)).toHaveAccessibleName(/Light rain, 56 F$/)
  await expectFitsPhone(page, 'mods settings with the weather back on')
})
