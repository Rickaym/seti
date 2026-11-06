const WEATHER_CONDITIONS = [
  'clear',
  'partly_cloudy',
  'cloudy',
  'fog',
  'drizzle',
  'rain',
  'heavy_rain',
  'thunderstorm',
  'snow',
  'sleet',
] as const

export type WeatherCondition = (typeof WEATHER_CONDITIONS)[number]

export const isWeatherCondition = (value: string | null): value is WeatherCondition =>
  WEATHER_CONDITIONS.some((condition) => condition === value)

/** A point to report weather for; the server rounds it to 0.1 degrees before it asks anyone. */
export interface ForecastPoint {
  lat: number
  lon: number
}

export interface WeatherSample {
  at: string
  condition: WeatherCondition
  /** Plain words for the WMO code, for example "Light rain". */
  label: string
  /** Degrees Celsius. */
  temperature: number
  /** Percent of the sky, from 0 to 100. */
  cloud_cover: number
  /** Millimetres per hour. */
  precipitation: number
  /** Kilometres per hour at 10 m. */
  wind_speed: number
  /** Degrees the wind blows from, clockwise from north. */
  wind_direction: number
  /** Metres, when the model reports it. */
  visibility: number | null
  is_day: boolean
}

/** Conditions now and hour by hour from a day back to a day and a half ahead. */
export interface WeatherReport {
  lat: number
  lon: number
  current: WeatherSample
  hours: WeatherSample[]
}

const CONDITION_LABELS: Record<WeatherCondition, string> = {
  clear: 'Clear',
  partly_cloudy: 'Partly cloudy',
  cloudy: 'Overcast',
  fog: 'Fog',
  drizzle: 'Drizzle',
  rain: 'Rain',
  heavy_rain: 'Heavy rain',
  thunderstorm: 'Thunderstorm',
  snow: 'Snow',
  sleet: 'Sleet',
}

export const conditionLabel = (condition: WeatherCondition): string => CONDITION_LABELS[condition]

type Described = readonly [WeatherCondition, string]

const WMO: Record<number, Described> = {
  0: ['clear', 'Clear'],
  1: ['partly_cloudy', 'Mainly clear'],
  2: ['partly_cloudy', 'Partly cloudy'],
  3: ['cloudy', 'Overcast'],
  45: ['fog', 'Fog'],
  48: ['fog', 'Rime fog'],
  51: ['drizzle', 'Light drizzle'],
  53: ['drizzle', 'Drizzle'],
  55: ['drizzle', 'Dense drizzle'],
  56: ['drizzle', 'Freezing drizzle'],
  57: ['drizzle', 'Dense freezing drizzle'],
  61: ['rain', 'Light rain'],
  63: ['rain', 'Rain'],
  65: ['heavy_rain', 'Heavy rain'],
  66: ['sleet', 'Freezing rain'],
  67: ['sleet', 'Heavy freezing rain'],
  71: ['snow', 'Light snow'],
  73: ['snow', 'Snow'],
  75: ['snow', 'Heavy snow'],
  77: ['snow', 'Snow grains'],
  80: ['rain', 'Light showers'],
  81: ['rain', 'Showers'],
  82: ['heavy_rain', 'Violent showers'],
  85: ['snow', 'Light snow showers'],
  86: ['snow', 'Heavy snow showers'],
  95: ['thunderstorm', 'Thunderstorm'],
  96: ['thunderstorm', 'Thunderstorm with hail'],
  99: ['thunderstorm', 'Thunderstorm with heavy hail'],
}

/** The condition and words for a WMO weather code; unknown codes fall back on the cloud cover. */
export function describeWeather(code: number, cloudCover: number): { condition: WeatherCondition; label: string } {
  const known = WMO[code]
  if (known) {
    return { condition: known[0], label: known[1] }
  }
  let condition: WeatherCondition = 'clear'
  if (cloudCover >= 70) {
    condition = 'cloudy'
  } else if (cloudCover >= 20) {
    condition = 'partly_cloudy'
  }
  return { condition, label: conditionLabel(condition) }
}
