import { isWeatherCondition, type WeatherCondition } from './report.js'

const LEGACY_KEY = 'seti-ui-weather'
const PREVIEW_KEY = 'seti-weather-preview'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Whether this browser had the weather turned off before the choice moved to the server. */
export const legacyWeatherOff = (): boolean => read(LEGACY_KEY) === 'off'

/** Forgets the browser's old choice once the server holds it. */
export function forgetLegacyWeather(): void {
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    // Storage can be blocked; the old choice then has nothing to forget.
  }
}

/** A condition to draw instead of the real weather, from `?weather=` or localStorage, for review. */
export function weatherPreview(search: string = window.location.search): WeatherCondition | null {
  const asked = new URLSearchParams(search).get('weather') ?? read(PREVIEW_KEY)
  return isWeatherCondition(asked) ? asked : null
}
