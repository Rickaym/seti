import type { APIRequestContext, Page } from '@playwright/test'
import { setModEnabled } from './mods.js'

/** The fields of the weather mod's forecast that the band reads. */
interface Sample {
  at: string
  condition: string
  label: string
  temperature: number
  cloud_cover: number
  precipitation: number
  wind_speed: number
  wind_direction: number
  visibility: number | null
  is_day: boolean
}

export const NOW = new Date('2026-06-21T14:30:00+02:00')

function sample(at: number, overrides: Partial<Sample> = {}): Sample {
  return {
    at: new Date(at).toISOString(),
    condition: 'rain',
    label: 'Light rain',
    temperature: 13.6,
    cloud_cover: 96,
    precipitation: 0.8,
    wind_speed: 14,
    wind_direction: 250,
    visibility: 9000,
    is_day: true,
    ...overrides,
  }
}

const REPORT = {
  lat: 52.5,
  lon: 13.4,
  current: sample(NOW.getTime()),
  hours: Array.from({ length: 48 }, (_, index) => sample(NOW.getTime() + (index - 24) * 3_600_000)),
}

/** Answers the band's forecast polls with light rain, and lists the queries they sent. */
export async function mockWeather(page: Page): Promise<string[]> {
  const asked: string[] = []
  await page.route(/\/api\/mods\/weather\/forecast\?/, async (route) => {
    asked.push(new URL(route.request().url()).search)
    await route.fulfill({ json: { data: REPORT, meta: {} } })
  })
  return asked
}

/** The daylight band in the app header. */
export const band = (page: Page) => page.getByRole('banner').getByRole('img', { name: /^Daylight/ })

/** Turns the weather mod back on with its default settings, so the next test starts clean. */
export async function resetWeatherMod(request: APIRequestContext): Promise<void> {
  await setModEnabled(request, 'weather', true)
  await request.patch('/api/mods/weather', { data: { settings: { weather: true, units: 'Celsius', location: '' } } })
}
