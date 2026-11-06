import type { GeoPoint } from './solar'

/** Low precision lunar position after Meeus, good to a degree or so; enough to draw the moon. */

export interface MoonState {
  /** Degrees above the horizon, corrected for parallax. */
  altitude: number
  /** Share of the synodic month: 0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter. */
  phase: number
  /** Illuminated share of the disc, from 0 to 1. */
  lit: number
}

const RAD = Math.PI / 180
const DAY = 86_400_000
const J2000 = Date.UTC(2000, 0, 1, 12)
const OBLIQUITY = 23.4397 * RAD
const EARTH_RADIUS_KM = 6378.14

const turn = (angle: number) => (((angle / (2 * Math.PI)) % 1) + 1) % 1

function sunLongitude(days: number): number {
  const anomaly = RAD * (357.5291 + 0.985_600_28 * days)
  const center = RAD * (1.9148 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly) + 0.0003 * Math.sin(3 * anomaly))
  return anomaly + center + RAD * 102.9372 + Math.PI
}

/** The moon seen from `point` at the instant `at`. */
export function moonState(at: number, point: GeoPoint): MoonState {
  const days = (at - J2000) / DAY
  const meanLongitude = RAD * (218.316 + 13.176_396 * days)
  const anomaly = RAD * (134.963 + 13.064_993 * days)
  const node = RAD * (93.272 + 13.22935 * days)
  const longitude = meanLongitude + RAD * 6.289 * Math.sin(anomaly)
  const latitude = RAD * 5.128 * Math.sin(node)
  const distance = 385_001 - 20_905 * Math.cos(anomaly)

  const rightAscension = Math.atan2(
    Math.sin(longitude) * Math.cos(OBLIQUITY) - Math.tan(latitude) * Math.sin(OBLIQUITY),
    Math.cos(longitude),
  )
  const declination = Math.asin(
    Math.sin(latitude) * Math.cos(OBLIQUITY) + Math.cos(latitude) * Math.sin(OBLIQUITY) * Math.sin(longitude),
  )
  const sidereal = RAD * (280.16 + 360.985_623_5 * days + point.lon)
  const hourAngle = sidereal - rightAscension
  const lat = point.lat * RAD
  const geocentric = Math.asin(
    Math.sin(lat) * Math.sin(declination) + Math.cos(lat) * Math.cos(declination) * Math.cos(hourAngle),
  )
  const altitude = geocentric - Math.asin((EARTH_RADIUS_KM / distance) * Math.cos(geocentric))

  const phase = turn(longitude - sunLongitude(days))
  return { altitude: altitude / RAD, phase, lit: (1 - Math.cos(2 * Math.PI * phase)) / 2 }
}

/** SVG path of the lit part of a moon of radius `r` centred on the origin, lit from the right. */
export function moonLitPath(phase: number, r: number): string {
  const waxing = phase < 0.5
  const terminator = r * Math.abs(Math.cos(2 * Math.PI * phase))
  const crescent = phase < 0.25 || phase > 0.75
  const limbSweep = waxing ? 1 : 0
  const terminatorSweep = crescent === waxing ? 0 : 1
  const rx = terminator.toFixed(3)
  return `M0 ${String(-r)}A${String(r)} ${String(r)} 0 0 ${String(limbSweep)} 0 ${String(r)}A${rx} ${String(r)} 0 0 ${String(terminatorSweep)} 0 ${String(-r)}Z`
}
