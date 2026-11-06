import { ALTITUDE, crossing, type GeoPoint, solarNoon, sunAltitude } from './solar'

type Sky = 'night' | 'twilight' | 'dawn' | 'day' | 'noon' | 'dusk'

export interface SkyStop {
  /** Position within the day, from 0 at its start to 1 at its end. */
  offset: number
  sky: Sky
}

export interface Daylight {
  start: number
  end: number
  sunrise: number | null
  sunset: number | null
  /** Set when the sun never crosses the horizon on this day. */
  polar: 'day' | 'night' | null
  stops: SkyStop[]
}

const PHASES: readonly { altitude: number; morning: Sky; evening: Sky }[] = [
  { altitude: ALTITUDE.nautical, morning: 'night', evening: 'night' },
  { altitude: ALTITUDE.civil, morning: 'twilight', evening: 'twilight' },
  { altitude: ALTITUDE.horizon, morning: 'dawn', evening: 'dusk' },
  { altitude: ALTITUDE.golden, morning: 'day', evening: 'day' },
]

function skyAt(altitude: number): Sky {
  if (altitude >= ALTITUDE.golden) {
    return 'day'
  }
  if (altitude >= ALTITUDE.horizon) {
    return 'dusk'
  }
  return altitude >= ALTITUDE.civil ? 'twilight' : 'night'
}

/** Sun times and sky gradient stops for the local day from `start` to `end` (epoch ms). */
export function daylight(start: number, end: number, point: GeoPoint): Daylight {
  const offsetOf = (at: number) => (at - start) / (end - start)
  const noon = solarNoon((start + end) / 2, point)
  const noonAltitude = sunAltitude(noon, point)
  const stops: SkyStop[] = [
    { offset: 0, sky: skyAt(sunAltitude(start, point)) },
    { offset: offsetOf(noon), sky: noonAltitude >= ALTITUDE.golden ? 'noon' : skyAt(noonAltitude) },
    { offset: 1, sky: skyAt(sunAltitude(end, point)) },
  ]
  for (const phase of PHASES) {
    const times = crossing(noon, point, phase.altitude)
    if (times) {
      stops.push(
        { offset: offsetOf(times.rise), sky: phase.morning },
        { offset: offsetOf(times.set), sky: phase.evening },
      )
    }
  }
  const horizon = crossing(noon, point, ALTITUDE.horizon)
  let polar: Daylight['polar'] = null
  if (!horizon) {
    polar = noonAltitude > ALTITUDE.horizon ? 'day' : 'night'
  }
  return {
    start,
    end,
    sunrise: horizon?.rise ?? null,
    sunset: horizon?.set ?? null,
    polar,
    stops: stops.filter((stop) => stop.offset >= 0 && stop.offset <= 1).sort((a, b) => a.offset - b.offset),
  }
}
