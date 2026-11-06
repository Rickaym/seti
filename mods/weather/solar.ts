/** NOAA general solar position equations, https://gml.noaa.gov/grad/solcalc/solareqns.PDF */

export interface GeoPoint {
  /** Degrees north. */
  lat: number
  /** Degrees east. */
  lon: number
}

export interface Crossing {
  rise: number
  set: number
}

/** Sun altitudes in degrees that name the phases of the day. */
export const ALTITUDE = {
  nautical: -12,
  civil: -6,
  horizon: -0.833,
  golden: 6,
} as const

const MINUTE = 60_000
const DAY = 86_400_000
const RAD = Math.PI / 180

interface SunState {
  /** Equation of time in minutes. */
  eqTime: number
  /** Declination in radians. */
  decl: number
}

function sunState(at: number): SunState {
  const date = new Date(at)
  const year = date.getUTCFullYear()
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const dayOfYear = Math.floor((at - Date.UTC(year, 0, 1)) / DAY) + 1
  const hour = (at - Date.UTC(year, date.getUTCMonth(), date.getUTCDate())) / 3_600_000
  const g = ((2 * Math.PI) / (leap ? 366 : 365)) * (dayOfYear - 1 + (hour - 12) / 24)
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(g) -
      0.032077 * Math.sin(g) -
      0.014615 * Math.cos(2 * g) -
      0.040849 * Math.sin(2 * g))
  const decl =
    0.006918 -
    0.399912 * Math.cos(g) +
    0.070257 * Math.sin(g) -
    0.006758 * Math.cos(2 * g) +
    0.000907 * Math.sin(2 * g) -
    0.002697 * Math.cos(3 * g) +
    0.00148 * Math.sin(3 * g)
  return { eqTime, decl }
}

/** The solar noon at `point` closest to the instant `near`. */
export function solarNoon(near: number, point: GeoPoint): number {
  const utcMidnight = Math.floor(near / DAY) * DAY
  const noonOf = (midnight: number) => midnight + (720 - 4 * point.lon - sunState(midnight + DAY / 2).eqTime) * MINUTE
  const noon = noonOf(utcMidnight)
  const shift = Math.round((near - noon) / DAY)
  return shift === 0 ? noon : noonOf(utcMidnight + shift * DAY)
}

/** When the sun passes `altitude` degrees on the day of `noon`; null if it never does. */
export function crossing(noon: number, point: GeoPoint, altitude: number): Crossing | null {
  const { decl } = sunState(noon)
  const lat = point.lat * RAD
  const cosHourAngle =
    (Math.cos((90 - altitude) * RAD) - Math.sin(lat) * Math.sin(decl)) / (Math.cos(lat) * Math.cos(decl))
  if (cosHourAngle < -1 || cosHourAngle > 1) {
    return null
  }
  const offset = (4 * Math.acos(cosHourAngle)) / RAD
  return { rise: noon - offset * MINUTE, set: noon + offset * MINUTE }
}

/** Sun altitude above the horizon in degrees at the instant `at`, ignoring refraction. */
export function sunAltitude(at: number, point: GeoPoint): number {
  const { eqTime, decl } = sunState(at)
  const utcMinutes = (at - Math.floor(at / DAY) * DAY) / MINUTE
  const hourAngle = ((utcMinutes + eqTime + 4 * point.lon) / 4 - 180) * RAD
  const lat = point.lat * RAD
  const cosZenith = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle)
  return 90 - Math.acos(Math.min(1, Math.max(-1, cosZenith))) / RAD
}
