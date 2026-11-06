import { starlight } from './sky'
import {
  clearness,
  haze,
  type Precipitation,
  precipitationOf,
  smoothstep,
  storminess,
  type WeatherField,
} from './weather'

/** A star of the band in CSS pixels, with the opacity it is drawn at now. */
export interface SceneStar {
  x: number
  y: number
  opacity: number
  weight: number
}

/** Everything the weather renderer draws from, in CSS pixels of the band. */
export interface WeatherScene {
  width: number
  height: number
  horizon: number
  field: WeatherField
  /** Sun altitude in degrees at a day offset. */
  altitude: (offset: number) => number
  /** Day offset of solar noon, which tells dawn from dusk. */
  noon: number
  stars: readonly SceneStar[]
  reducedMotion: boolean
}

/** Width in CSS pixels of the columns the weather is sampled in. */
export const COLUMN = 4

/** Particles in the air per CSS pixel of band width for each kind of precipitation. */
const DENSITY: Record<Precipitation, number> = { drizzle: 0.07, rain: 0.08, heavy: 0.15, snow: 0.075, sleet: 0.08 }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value))

function intensity(kind: Precipitation, mmPerHour: number): number {
  switch (kind) {
    case 'drizzle':
      return clamp(0.7 + mmPerHour, 0.7, 1.3)
    case 'rain':
    case 'sleet':
      return clamp(0.6 + mmPerHour / 3.5, 0.6, 1.4)
    case 'heavy':
      return clamp(0.75 + mmPerHour / 20, 0.75, 1.3)
    case 'snow':
      return clamp(0.6 + mmPerHour / 2.5, 0.6, 1.5)
  }
}

/** The scene sampled once per column, so each frame only indexes arrays. */
export interface Columns {
  count: number
  cover: Float32Array
  storm: Float32Array
  haze: Float32Array
  /** 1 where the sun is well below the horizon. */
  night: Float32Array
  /** Strength of the low sun's colour, peaking as it crosses the horizon. */
  glow: Float32Array
  evening: Uint8Array
  kind: (Precipitation | null)[]
  /** Particles per CSS pixel of width. */
  density: Float32Array
  thunder: Float32Array
  /** Chance of seeing a shooting star: a dark, clear sky. */
  meteor: Float32Array
}

export function columnsOf(scene: WeatherScene): Columns {
  const count = Math.max(1, Math.ceil(scene.width / COLUMN) + 1)
  const columns: Columns = {
    count,
    cover: new Float32Array(count),
    storm: new Float32Array(count),
    haze: new Float32Array(count),
    night: new Float32Array(count),
    glow: new Float32Array(count),
    evening: new Uint8Array(count),
    kind: [],
    density: new Float32Array(count),
    thunder: new Float32Array(count),
    meteor: new Float32Array(count),
  }
  for (let index = 0; index < count; index += 1) {
    const offset = Math.min(1, (index * COLUMN) / Math.max(1, scene.width))
    const point = scene.field.at(offset)
    const altitude = scene.altitude(offset)
    const kind = precipitationOf(point.condition)
    columns.cover[index] = point.cover
    columns.storm[index] = storminess(point.condition)
    columns.haze[index] = haze(point)
    columns.night[index] = smoothstep(-2, -9, altitude)
    columns.glow[index] = Math.max(0, 1 - Math.abs(altitude - 1) / 7)
    columns.evening[index] = offset > scene.noon ? 1 : 0
    columns.kind.push(kind)
    columns.density[index] = kind === null ? 0 : DENSITY[kind] * intensity(kind, point.precipitation)
    columns.thunder[index] = point.condition === 'thunderstorm' ? 1 : 0
    columns.meteor[index] = starlight(altitude) * clearness(point)
  }
  return columns
}

export const columnAt = (columns: Columns, x: number): number => clamp(Math.round(x / COLUMN), 0, columns.count - 1)

/** Draws column indices in proportion to `weights`, given a uniform number in [0, 1). */
export interface Sampler {
  total: number
  pick: (u: number) => number
}

export function samplerOf(weights: Float32Array): Sampler {
  const cumulative = new Float32Array(weights.length)
  let total = 0
  weights.forEach((weight, index) => {
    total += weight
    cumulative[index] = total
  })
  const pick = (u: number) => {
    const target = u * total
    let low = 0
    let high = cumulative.length - 1
    while (low < high) {
      const middle = (low + high) >> 1
      if ((cumulative[middle] ?? 0) < target) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    return low
  }
  return { total, pick }
}

/** A small seeded generator, so a scene draws the same on every load and in tests. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
