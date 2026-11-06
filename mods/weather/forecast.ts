import type { ServerModApi } from '@seti/mod-api'
import { describeWeather, type ForecastPoint, type WeatherReport, type WeatherSample } from './report.js'

/** Open-Meteo refreshes its models every 15 minutes at best, so ten minutes loses nothing. */
const TTL_SECONDS = 600
/** A failed lookup is remembered briefly so a flaky upstream is not asked on every poll. */
const FAILURE_TTL_SECONDS = 120
const DEFAULT_URL = 'https://api.open-meteo.com/v1/forecast'
const FIELDS = [
  'temperature_2m',
  'weather_code',
  'cloud_cover',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'visibility',
  'is_day',
] as const

type Field = (typeof FIELDS)[number]
type Readings = Partial<Record<Field, number | null | undefined>>

/** The forecast endpoint from SETI_WEATHER_URL, Open-Meteo's without it, or null when it is off. */
export function forecastUrl(value: string | undefined): string | null {
  if (value === 'off') {
    return null
  }
  const text = value ?? DEFAULT_URL
  const url = URL.canParse(text) ? new URL(text) : null
  if (url?.protocol !== 'https:') {
    throw new Error(`SETI_WEATHER_URL must be an https URL or off, not ${text}`)
  }
  return url.toString()
}

/** Tenths of a degree, about 11 km: close enough for the sky and too coarse to find anyone. */
export const roundPoint = (point: ForecastPoint): ForecastPoint => ({
  lat: Math.round(point.lat * 10) / 10,
  lon: Math.round(point.lon * 10) / 10,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function reading(value: unknown): number | null | undefined {
  if (value === null) {
    return null
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

const readingsOf = (pick: (field: Field) => unknown): Readings =>
  Object.fromEntries(FIELDS.map((field) => [field, reading(pick(field))]))

function sample(unixSeconds: number, readings: Readings, perHour: number): WeatherSample | null {
  const temperature = readings.temperature_2m
  const code = readings.weather_code
  if (temperature === null || temperature === undefined || code === null || code === undefined) {
    return null
  }
  const cloudCover = readings.cloud_cover ?? 0
  return {
    at: new Date(unixSeconds * 1000).toISOString(),
    ...describeWeather(code, cloudCover),
    temperature,
    cloud_cover: cloudCover,
    precipitation: (readings.precipitation ?? 0) * perHour,
    wind_speed: readings.wind_speed_10m ?? 0,
    wind_direction: readings.wind_direction_10m ?? 0,
    visibility: readings.visibility ?? null,
    is_day: (readings.is_day ?? 1) === 1,
  }
}

function hourlySamples(hourly: Record<string, unknown>, times: readonly unknown[]): WeatherSample[] {
  const at = (field: Field, index: number): unknown => {
    const values = hourly[field]
    return Array.isArray(values) ? (values as unknown[])[index] : undefined
  }
  return times.flatMap((time, index) =>
    typeof time === 'number'
      ? (sample(
          time,
          readingsOf((field) => at(field, index)),
          1,
        ) ?? [])
      : [],
  )
}

/** The report in Seti's shape, or null when Open-Meteo sent nothing usable. */
export function toReport(point: ForecastPoint, body: unknown): WeatherReport | null {
  const current = isRecord(body) ? body.current : null
  const hourly = isRecord(body) ? body.hourly : null
  const times: unknown = isRecord(hourly) ? hourly.time : null
  if (!isRecord(current) || !isRecord(hourly) || !Array.isArray(times)) {
    return null
  }
  const { time, interval } = current
  if (typeof time !== 'number' || typeof interval !== 'number' || interval <= 0) {
    return null
  }
  const now = sample(
    time,
    readingsOf((field) => current[field]),
    3600 / interval,
  )
  return now === null ? null : { ...point, current: now, hours: hourlySamples(hourly, times as unknown[]) }
}

/** Weather near a point, or null when it cannot be had. */
export type Forecaster = (point: ForecastPoint) => Promise<WeatherReport | null>

/** Asks the endpoint through the mod's fetch, sharing each answer across callers and processes. */
export function forecaster(api: Pick<ServerModApi, 'fetch' | 'cache'>, endpoint: string | null): Forecaster {
  const pending = new Map<string, Promise<WeatherReport | null>>()

  const fetchReport = async (point: ForecastPoint): Promise<WeatherReport | null> => {
    if (endpoint === null) {
      return null
    }
    const url = new URL(endpoint)
    const params = {
      latitude: String(point.lat),
      longitude: String(point.lon),
      current: FIELDS.join(','),
      hourly: FIELDS.join(','),
      past_hours: '24',
      forecast_hours: '36',
      timeformat: 'unixtime',
      timezone: 'GMT',
    }
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }
    try {
      const res = await api.fetch(url.toString())
      return res.status >= 200 && res.status < 300 ? toReport(point, JSON.parse(res.body)) : null
    } catch {
      return null
    }
  }

  const lookup = async (key: string, point: ForecastPoint): Promise<WeatherReport | null> => {
    const known = await api.cache.get(key)
    if (known !== undefined) {
      return known as WeatherReport | null
    }
    const report = await fetchReport(point)
    await api.cache.set(key, report, report === null ? FAILURE_TTL_SECONDS : TTL_SECONDS)
    return report
  }

  return async (point) => {
    const rounded = roundPoint(point)
    const key = `forecast:${rounded.lat.toFixed(1)}:${rounded.lon.toFixed(1)}`
    const inFlight = pending.get(key)
    if (inFlight) {
      return inFlight
    }
    const request = lookup(key, rounded).finally(() => pending.delete(key))
    pending.set(key, request)
    return request
  }
}

function coordinate(text: string | undefined, limit: number): number | null {
  const value = text === undefined || text.trim() === '' ? Number.NaN : Number(text)
  return Number.isFinite(value) && Math.abs(value) <= limit ? value : null
}

/** The point a request asks about, or null when it is off the globe or asks for more. */
export function pointOf(query: Readonly<Record<string, string>>): ForecastPoint | null {
  const lat = coordinate(query.lat, 90)
  const lon = coordinate(query.lon, 180)
  const extra = Object.keys(query).some((key) => key !== 'lat' && key !== 'lon')
  return lat === null || lon === null || extra ? null : { lat, lon }
}
