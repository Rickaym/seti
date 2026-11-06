import type { ModFetchResponse, ModRouteHandler, ServerModApi } from '@seti/mod-api'
import { describe, expect, it, vi } from 'vitest'
import { forecastUrl, roundPoint, toReport } from './forecast.js'
import { describeWeather, type WeatherReport } from './report.js'
import { weatherServer } from './server.js'

/** An Open-Meteo forecast body as it answers for Berlin: light rain now, three hours of forecast. */
function openMeteoBody(code = 61) {
  const start = Date.parse('2026-09-28T10:00:00Z') / 1000
  return {
    latitude: 52.52,
    longitude: 13.4,
    current: {
      time: start + 2700,
      interval: 900,
      temperature_2m: 13.6,
      weather_code: code,
      cloud_cover: 96,
      precipitation: 0.2,
      wind_speed_10m: 14.2,
      wind_direction_10m: 250,
      visibility: 9000,
      is_day: 1,
    },
    hourly: {
      time: [start, start + 3600, start + 7200],
      temperature_2m: [13.1, 13.9, null],
      weather_code: [3, 61, 63],
      cloud_cover: [100, 96, 98],
      precipitation: [0, 0.6, 1.4],
      wind_speed_10m: [12, 14, 16],
      wind_direction_10m: [240, 250, 255],
      visibility: [20000, 9000, null],
      is_day: [1, 1, 1],
    },
  }
}

const answer = async (body: unknown, status = 200): Promise<ModFetchResponse> =>
  Promise.resolve({ status, url: '', headers: [], body: JSON.stringify(body) })

/** The weather mod's server half on a fake mod API, with its cache in memory. */
function startWeather(fetch: (url: string) => Promise<ModFetchResponse>, env: Record<string, string> = {}) {
  const routes = new Map<string, ModRouteHandler>()
  const cached = new Map<string, { value: unknown; ttl: number }>()
  const fetchMock = vi.fn(fetch)
  const api = {
    fetch: fetchMock,
    env: (name: string) => env[name],
    cache: {
      get: async (key: string) => Promise.resolve(cached.get(key)?.value),
      set: async (key: string, value: unknown, ttl: number) => {
        cached.set(key, { value, ttl })
        return Promise.resolve()
      },
    },
    route: (method: string, path: string, handler: ModRouteHandler) => {
      routes.set(`${method} ${path}`, handler)
      return () => undefined
    },
  } as unknown as ServerModApi
  weatherServer.server(api)
  const forecast = async (query: Record<string, string>) => {
    const handler = routes.get('GET /forecast')
    if (handler === undefined) {
      throw new Error('The weather mod answers no GET /forecast')
    }
    const res = await handler({ params: {}, query, body: null, caller: { source: 'user', agent: null } })
    return { status: res.status ?? 200, data: res.body as WeatherReport | null }
  }
  return { forecast, fetchMock, cached }
}

describe('describeWeather', () => {
  it.each([
    [0, 'clear', 'Clear'],
    [1, 'partly_cloudy', 'Mainly clear'],
    [2, 'partly_cloudy', 'Partly cloudy'],
    [3, 'cloudy', 'Overcast'],
    [45, 'fog', 'Fog'],
    [48, 'fog', 'Rime fog'],
    [51, 'drizzle', 'Light drizzle'],
    [57, 'drizzle', 'Dense freezing drizzle'],
    [61, 'rain', 'Light rain'],
    [63, 'rain', 'Rain'],
    [65, 'heavy_rain', 'Heavy rain'],
    [66, 'sleet', 'Freezing rain'],
    [71, 'snow', 'Light snow'],
    [77, 'snow', 'Snow grains'],
    [80, 'rain', 'Light showers'],
    [82, 'heavy_rain', 'Violent showers'],
    [86, 'snow', 'Heavy snow showers'],
    [95, 'thunderstorm', 'Thunderstorm'],
    [99, 'thunderstorm', 'Thunderstorm with heavy hail'],
  ])('maps WMO code %i to %s', (code, condition, label) => {
    expect(describeWeather(code, 0)).toEqual({ condition, label })
  })

  it('falls back on the cloud cover for codes it does not know', () => {
    expect(describeWeather(42, 5)).toEqual({ condition: 'clear', label: 'Clear' })
    expect(describeWeather(42, 40)).toEqual({ condition: 'partly_cloudy', label: 'Partly cloudy' })
    expect(describeWeather(42, 90)).toEqual({ condition: 'cloudy', label: 'Overcast' })
  })
})

describe('toReport', () => {
  it('turns an Open-Meteo body into conditions now and by the hour', () => {
    const report = toReport({ lat: 52.5, lon: 13.4 }, openMeteoBody())
    expect(report?.current).toEqual({
      at: '2026-09-28T10:45:00.000Z',
      condition: 'rain',
      label: 'Light rain',
      temperature: 13.6,
      cloud_cover: 96,
      precipitation: 0.8,
      wind_speed: 14.2,
      wind_direction: 250,
      visibility: 9000,
      is_day: true,
    })
    expect(report?.hours.map((hour) => [hour.at, hour.condition, hour.precipitation])).toEqual([
      ['2026-09-28T10:00:00.000Z', 'cloudy', 0],
      ['2026-09-28T11:00:00.000Z', 'rain', 0.6],
    ])
  })

  it('refuses bodies without the current conditions', () => {
    expect(toReport({ lat: 0, lon: 0 }, { error: true, reason: 'Invalid' })).toBeNull()
    expect(toReport({ lat: 0, lon: 0 }, { ...openMeteoBody(), current: { time: 1, interval: 900 } })).toBeNull()
  })
})

describe('roundPoint', () => {
  it('keeps a tenth of a degree', () => {
    expect(roundPoint({ lat: 52.5234, lon: 13.4049 })).toEqual({ lat: 52.5, lon: 13.4 })
    expect(roundPoint({ lat: -33.8688, lon: 151.2093 })).toEqual({ lat: -33.9, lon: 151.2 })
  })
})

describe('forecastUrl', () => {
  it("uses Open-Meteo's endpoint by default, reads off as none, and takes only https", () => {
    expect(forecastUrl(undefined)).toBe('https://api.open-meteo.com/v1/forecast')
    expect(forecastUrl('off')).toBeNull()
    expect(() => forecastUrl('api.open-meteo.com')).toThrow(/SETI_WEATHER_URL/)
    expect(() => forecastUrl('file:///etc/passwd')).toThrow(/SETI_WEATHER_URL/)
  })
})

describe('GET /api/mods/weather/forecast', () => {
  it('asks Open-Meteo for the rounded point and answers in Seti shape', async () => {
    const { forecast, fetchMock } = startWeather(async () => answer(openMeteoBody()))
    const { status, data } = await forecast({ lat: '52.5234', lon: '13.4049' })
    expect(status).toBe(200)
    expect(data?.current.label).toBe('Light rain')
    expect(data).toMatchObject({ lat: 52.5, lon: 13.4 })
    const asked = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(asked.origin + asked.pathname).toBe('https://api.open-meteo.com/v1/forecast')
    expect(asked.searchParams.get('latitude')).toBe('52.5')
    expect(asked.searchParams.get('longitude')).toBe('13.4')
    expect(asked.searchParams.get('current')).toContain('weather_code')
    expect(asked.searchParams.get('past_hours')).toBe('24')
  })

  it('shares one upstream request between callers asking at once', async () => {
    const { forecast, fetchMock } = startWeather(async () => answer(openMeteoBody()))
    const answers = await Promise.all([
      forecast({ lat: '10.01', lon: '20.02' }),
      forecast({ lat: '10.04', lon: '19.98' }),
    ])
    expect(answers.map((one) => one.data?.current.condition)).toEqual(['rain', 'rain'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a report for ten minutes per rounded point', async () => {
    const { forecast, fetchMock, cached } = startWeather(async () => answer(openMeteoBody()))
    expect((await forecast({ lat: '48.137', lon: '11.575' })).data?.current.label).toBe('Light rain')
    expect((await forecast({ lat: '48.14', lon: '11.58' })).data?.current.label).toBe('Light rain')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cached.get('forecast:48.1:11.6')).toMatchObject({ ttl: 600, value: { lat: 48.1, lon: 11.6 } })
    await forecast({ lat: '48.3', lon: '11.6' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('remembers a failure briefly instead of asking on every poll', async () => {
    const { forecast, fetchMock, cached } = startWeather(async () => Promise.reject(new TypeError('refused')))
    expect((await forecast({ lat: '-12.07', lon: '-77.04' })).data).toBeNull()
    expect((await forecast({ lat: '-12.07', lon: '-77.04' })).data).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(cached.get('forecast:-12.1:-77.0')).toEqual({ ttl: 120, value: null })
  })

  it.each([
    ['is down', async () => Promise.reject(new TypeError('fetch failed'))],
    ['answers with an error', async () => answer({ error: true, reason: 'Rate limited' }, 429)],
    ['answers with nonsense', async () => answer({ hello: 'world' })],
  ])('answers null when Open-Meteo %s', async (_case, reply) => {
    const { forecast } = startWeather(reply)
    const { status, data } = await forecast({ lat: '1', lon: '2' })
    expect(status).toBe(200)
    expect(data).toBeNull()
  })

  it('answers null without asking anyone when SETI_WEATHER_URL is off', async () => {
    const { forecast, fetchMock } = startWeather(async () => answer(openMeteoBody()), { URL: 'off' })
    expect((await forecast({ lat: '1', lon: '2' })).data).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects points off the globe and missing coordinates', async () => {
    const { forecast, fetchMock } = startWeather(async () => answer(openMeteoBody()))
    expect((await forecast({ lat: '91', lon: '0' })).status).toBe(400)
    expect((await forecast({ lat: '0', lon: '-181' })).status).toBe(400)
    expect((await forecast({ lat: '0' })).status).toBe(400)
    expect((await forecast({ lat: 'north', lon: '0' })).status).toBe(400)
    expect((await forecast({ lat: '0', lon: '0', zoom: '1' })).status).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
