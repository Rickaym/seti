import { conditionLabel, type WeatherCondition, type WeatherReport, type WeatherSample } from './report.js'

/** The weather at one moment of the band, blended between the nearest reports. */
export interface WeatherPoint {
  condition: WeatherCondition
  /** Share of the sky under cloud, from 0 to 1. */
  cover: number
  /** Millimetres per hour. */
  precipitation: number
  /** Metres, or null when unknown. */
  visibility: number | null
}

export interface WeatherField {
  current: WeatherSample
  /** Eastward wind in km/h, so positive values carry clouds to the right. */
  drift: number
  at: (offset: number) => WeatherPoint
}

export type Precipitation = 'drizzle' | 'rain' | 'heavy' | 'snow' | 'sleet'

const HOUR = 3_600_000

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value))

/** 0 at `from`, 1 at `to` with an eased ramp between; `from` may exceed `to`. */
export function smoothstep(from: number, to: number, value: number): number {
  const t = clamp((value - from) / (to - from))
  return t * t * (3 - 2 * t)
}

const pointOf = (sample: WeatherSample): WeatherPoint => ({
  condition: sample.condition,
  cover: clamp(sample.cloud_cover / 100),
  precipitation: Math.max(0, sample.precipitation),
  visibility: sample.visibility,
})

function blend(a: WeatherPoint, b: WeatherPoint, t: number): WeatherPoint {
  const lerp = (x: number, y: number) => x + (y - x) * t
  let visibility = a.visibility ?? b.visibility
  if (a.visibility !== null && b.visibility !== null) {
    visibility = lerp(a.visibility, b.visibility)
  }
  return {
    condition: t < 0.5 ? a.condition : b.condition,
    cover: lerp(a.cover, b.cover),
    precipitation: lerp(a.precipitation, b.precipitation),
    visibility,
  }
}

/** The report spread over the day from `start` to `end`, with the current reading at its moment. */
export function weatherField(report: WeatherReport, start: number, end: number): WeatherField {
  const timeline = [...report.hours, report.current]
    .map((sample) => ({ offset: (Date.parse(sample.at) - start) / (end - start), point: pointOf(sample) }))
    .sort((a, b) => a.offset - b.offset)
  const radians = (report.current.wind_direction * Math.PI) / 180
  const at = (offset: number): WeatherPoint => {
    const after = timeline.findIndex((entry) => entry.offset >= offset)
    const next = timeline[after]
    const previous = timeline[after - 1]
    if (next === undefined) {
      return timeline.at(-1)?.point ?? pointOf(report.current)
    }
    if (previous === undefined || next.offset === previous.offset) {
      return next.point
    }
    return blend(previous.point, next.point, (offset - previous.offset) / (next.offset - previous.offset))
  }
  return { current: report.current, drift: -Math.sin(radians) * report.current.wind_speed, at }
}

export function precipitationOf(condition: WeatherCondition): Precipitation | null {
  switch (condition) {
    case 'drizzle':
      return 'drizzle'
    case 'rain':
      return 'rain'
    case 'heavy_rain':
    case 'thunderstorm':
      return 'heavy'
    case 'snow':
      return 'snow'
    case 'sleet':
      return 'sleet'
    case 'clear':
    case 'partly_cloudy':
    case 'cloudy':
    case 'fog':
      return null
  }
}

/** How dark and heavy the clouds are, from 0 for fair weather to 1 for a thunderstorm. */
export function storminess(condition: WeatherCondition): number {
  const levels: Record<WeatherCondition, number> = {
    clear: 0,
    partly_cloudy: 0,
    cloudy: 0.2,
    fog: 0.1,
    drizzle: 0.3,
    rain: 0.5,
    heavy_rain: 0.75,
    thunderstorm: 0.95,
    snow: 0.25,
    sleet: 0.45,
  }
  return levels[condition]
}

/** Haze near the ground, from 0 in clean air to about 0.85 in thick fog. */
export function haze(point: WeatherPoint): number {
  const thin = point.visibility === null ? 0 : 0.5 * smoothstep(8000, 800, point.visibility)
  const fog = point.condition === 'fog' ? 0.85 - 0.25 * smoothstep(200, 2000, point.visibility ?? 1000) : 0
  const heavy = point.condition === 'heavy_rain' || point.condition === 'snow' ? 0.15 : 0
  return Math.max(thin, fog, heavy)
}

/** How much of the starlight gets through, from 1 under a clear sky to 0 under overcast or fog. */
export function clearness(point: WeatherPoint): number {
  return (1 - smoothstep(0.3, 0.9, point.cover)) * (1 - haze(point))
}

/** How much the clouds, fog and rain veil the sun and moon, from 0 to about 0.9. */
export function veiling(point: WeatherPoint): number {
  return Math.max(0.9 * smoothstep(0.55, 1, point.cover), 0.9 * haze(point), storminess(point.condition) * 0.9)
}

export type TemperatureUnit = 'C' | 'F'

/** "Light rain, 14 C": the condition in words and the rounded temperature. */
export function weatherText(sample: WeatherSample, unit: TemperatureUnit = 'C'): string {
  const degrees = unit === 'F' ? (sample.temperature * 9) / 5 + 32 : sample.temperature
  return `${sample.label}, ${String(Math.round(degrees))} ${unit}`
}

type Preset = Pick<
  WeatherSample,
  'temperature' | 'cloud_cover' | 'precipitation' | 'wind_speed' | 'wind_direction' | 'visibility'
>

const PRESETS: Record<WeatherCondition, Preset> = {
  clear: { temperature: 17, cloud_cover: 0, precipitation: 0, wind_speed: 8, wind_direction: 250, visibility: 30000 },
  partly_cloudy: {
    temperature: 16,
    cloud_cover: 45,
    precipitation: 0,
    wind_speed: 16,
    wind_direction: 250,
    visibility: 25000,
  },
  cloudy: {
    temperature: 12,
    cloud_cover: 100,
    precipitation: 0,
    wind_speed: 14,
    wind_direction: 240,
    visibility: 18000,
  },
  fog: { temperature: 7, cloud_cover: 80, precipitation: 0, wind_speed: 4, wind_direction: 200, visibility: 250 },
  drizzle: {
    temperature: 11,
    cloud_cover: 95,
    precipitation: 0.3,
    wind_speed: 12,
    wind_direction: 240,
    visibility: 7000,
  },
  rain: { temperature: 12, cloud_cover: 100, precipitation: 2, wind_speed: 20, wind_direction: 250, visibility: 6000 },
  heavy_rain: {
    temperature: 13,
    cloud_cover: 100,
    precipitation: 8,
    wind_speed: 30,
    wind_direction: 255,
    visibility: 2500,
  },
  thunderstorm: {
    temperature: 21,
    cloud_cover: 100,
    precipitation: 10,
    wind_speed: 34,
    wind_direction: 260,
    visibility: 3000,
  },
  snow: {
    temperature: -2,
    cloud_cover: 100,
    precipitation: 1.2,
    wind_speed: 12,
    wind_direction: 300,
    visibility: 2500,
  },
  sleet: {
    temperature: 1,
    cloud_cover: 100,
    precipitation: 1.5,
    wind_speed: 18,
    wind_direction: 280,
    visibility: 4000,
  },
}

/** A steady report of one condition around `now`, for previewing how the band draws it. */
export function previewReport(condition: WeatherCondition, now: number): WeatherReport {
  const sample = (at: number): WeatherSample => ({
    at: new Date(at).toISOString(),
    condition,
    label: conditionLabel(condition),
    ...PRESETS[condition],
    is_day: true,
  })
  const hour = Math.floor(now / HOUR) * HOUR
  const hours = Array.from({ length: 61 }, (_, index) => sample(hour + (index - 24) * HOUR))
  return { lat: 0, lon: 0, current: sample(now), hours }
}
