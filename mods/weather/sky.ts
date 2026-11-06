import { ALTITUDE, type GeoPoint, sunAltitude } from './solar'

export interface SunSample {
  /** Position within the day, from 0 at its start to 1 at its end. */
  offset: number
  /** Degrees above the horizon. */
  altitude: number
}

/** Vertical layout of a sky band as fractions of its height, from 0 at the top. */
export interface ArcFrame {
  top: number
  horizon: number
  bottom: number
}

export interface Star {
  /** Fraction of the band width. */
  x: number
  /** Fraction of the height above the horizon, from 0 at the horizon to 1 at the top. */
  lift: number
  /** Relative brightness from 0 to 1. */
  weight: number
}

const OBLIQUITY = 23.44
const GOLDEN_RATIO = 0.618_033_988_75

/** The sun altitude sampled evenly over the day from `start` to `end` (epoch ms). */
export function sunPath(start: number, end: number, point: GeoPoint, steps: number): SunSample[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const offset = index / steps
    return { offset, altitude: sunAltitude(start + offset * (end - start), point) }
  })
}

/** The highest noon altitude the sun reaches in a year at `lat`, so arcs keep one scale all year. */
export function peakAltitude(lat: number): number {
  return Math.min(90, 90 - Math.abs(lat) + OBLIQUITY)
}

/** Where the sun at `altitude` sits in `frame`: the peak meets the top, its mirror the bottom. */
export function arcY(altitude: number, peak: number, frame: ArcFrame): number {
  const share = Math.max(-1, Math.min(1, altitude / peak))
  const span = share >= 0 ? frame.horizon - frame.top : frame.bottom - frame.horizon
  return frame.horizon - share * span
}

/** The sampled altitude at `offset`, interpolated between neighbouring samples. */
export function altitudeAt(path: readonly SunSample[], offset: number): number {
  const steps = path.length - 1
  const at = Math.max(0, Math.min(steps, offset * steps))
  const low = path[Math.floor(at)]
  const high = path[Math.ceil(at)]
  if (!low || !high) {
    return Number.NaN
  }
  return low.altitude + (high.altitude - low.altitude) * (at - Math.floor(at))
}

/** How dark the sky is for stars: 0 from civil twilight up, 1 from nautical twilight down. */
export function starlight(altitude: number): number {
  const depth = (ALTITUDE.civil - altitude) / (ALTITUDE.civil - ALTITUDE.nautical)
  return Math.max(0, Math.min(1, depth))
}

/** A fixed, evenly scattered field of `count` stars, the same on every render. */
export function starField(count: number): Star[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return {
      x: (n * GOLDEN_RATIO) % 1,
      lift: 0.2 + 0.75 * ((n * 0.754_877_666) % 1),
      weight: 0.35 + 0.65 * ((n * 0.569_840_29) % 1) ** 2,
    }
  })
}
