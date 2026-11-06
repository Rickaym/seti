import { expect, test } from './support/fixtures.js'
import { modToggle } from './support/mods.js'
import { band, mockWeather, NOW, resetWeatherMod } from './support/weather.js'

test.afterEach(async ({ request }) => {
  await resetWeatherMod(request)
})

test('the band draws the weather at the zone point and names it in its label', async ({ page }) => {
  const asked = await mockWeather(page)
  await page.clock.setFixedTime(NOW)
  await page.goto('/')
  await expect(band(page)).toHaveAccessibleName(/^Daylight, 02:30 PM\. Sunrise .+, sunset .+\. Light rain, 14 C$/)
  expect(asked).toEqual(['?lat=52.5&lon=13.4'])
  await expect(band(page).locator('canvas')).toHaveCount(3)
})

test("the Weather mod's settings turn the lookups off, name Fahrenheit and move the sky", async ({ page }) => {
  const asked = await mockWeather(page)
  await page.clock.setFixedTime(NOW)
  await page.goto('/#settings/weather.settings')
  const main = page.getByRole('main')
  const navItem = main.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Weather' })
  await expect(navItem.locator('svg.lucide-cloud-sun'), 'the page carries the mod icon').toHaveCount(1)
  const toggle = main.getByRole('region', { name: 'Settings' }).getByRole('button', { name: 'Weather', exact: true })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 14 C$/)

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(band(page)).toHaveAccessibleName(/sunset \d\d:\d\d PM$/)
  await expect(band(page).locator('canvas')).toHaveCount(0)

  await page.reload()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(band(page)).toHaveAccessibleName(/sunset \d\d:\d\d PM$/)
  expect(asked).toHaveLength(1)

  await toggle.click()
  await expect(band(page)).toHaveAccessibleName(/Light rain, 14 C$/)
  await main.getByRole('combobox', { name: 'Units' }).selectOption('Fahrenheit')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 56 F$/)

  const location = main.getByRole('textbox', { name: 'Location' })
  await location.fill('40.42, -3.7')
  await location.blur()
  await expect(band(page)).toHaveAccessibleName(/^Daylight, 02:30 PM\. Sunrise 06:4\d AM, sunset 09:4\d PM\./)
  await expect.poll(() => asked.at(-1)).toBe('?lat=40.4&lon=-3.7')
})

test('a browser that had the weather off moves that choice to the server once', async ({ page, request }) => {
  await mockWeather(page)
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded') === null) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('seti-ui-weather', 'off')
    }
  })
  await page.goto('/')
  await expect
    .poll(async () => {
      const detail = (await (await request.get('/api/mods/weather')).json()) as {
        data: { settings: { key: string; value: unknown }[] }
      }
      return detail.data.settings.find((setting) => setting.key === 'weather')?.value
    })
    .toBe(false)
  await expect.poll(async () => page.evaluate(() => localStorage.getItem('seti-ui-weather'))).toBeNull()
  await page.reload()
  await expect(band(page)).toHaveAccessibleName(/sunset \d\d:\d\d PM$/)
})

test('turning the Weather mod off takes the band and its route away, and on brings them back', async ({
  page,
  request,
}) => {
  await mockWeather(page)
  await page.clock.setFixedTime(NOW)
  await page.goto('/#settings/mods')
  const header = page.getByRole('banner')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 14 C$/)

  await modToggle(page, 'Weather').click()
  await expect(modToggle(page, 'Weather')).toHaveAttribute('aria-pressed', 'false')
  await expect(band(page)).toHaveCount(0)
  await expect(header.locator('[data-slot="header-gap"]')).toHaveCount(1)
  expect((await request.get('/api/mods/weather/forecast?lat=1&lon=2')).status()).toBe(404)
  const settingsNav = page.getByRole('main').getByRole('navigation', { name: 'Settings pages' })
  await expect(settingsNav.getByRole('button', { name: 'Weather' })).toHaveCount(0)

  await modToggle(page, 'Weather').click()
  await expect(modToggle(page, 'Weather')).toHaveAttribute('aria-pressed', 'true')
  await expect(band(page)).toHaveAccessibleName(/Light rain, 14 C$/)
  await expect(header.locator('[data-slot="header-gap"]')).toHaveCount(0)
  expect((await request.get('/api/mods/weather/forecast?lat=1&lon=2')).status()).toBe(200)
})

test('a preview draws any condition without asking the server', async ({ page }) => {
  const asked = await mockWeather(page)
  await page.clock.setFixedTime(NOW)
  await page.goto('/?weather=thunderstorm')
  await expect(band(page)).toHaveAccessibleName(/Thunderstorm, 21 C$/)
  expect(asked).toEqual([])
})
