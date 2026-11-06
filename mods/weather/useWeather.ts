import type { ModPolled, UiModApi } from '@seti/mod-api'
import { useMemo, useSyncExternalStore } from 'react'
import { weatherPreview } from './preview'
import type { WeatherReport } from './report.js'
import type { GeoPoint } from './solar'
import { previewReport } from './weather'

const POLL_MS = 10 * 60_000

type Forecast = ModPolled<WeatherReport | null>

/** The forecast poll of a point, shared by every band that shows it. */
export type Forecasts = (point: GeoPoint) => Forecast

const IDLE_STATE = { data: undefined, error: null }
const IDLE: Forecast = {
  subscribe: () => () => undefined,
  getSnapshot: () => IDLE_STATE,
  refresh: () => undefined,
}

/** One poll of the mod's forecast route per rounded point. */
export function forecastsOf(api: Pick<UiModApi, 'poll'>): Forecasts {
  const polls = new Map<string, Forecast>()
  return (point) => {
    const path = `/forecast?lat=${point.lat.toFixed(1)}&lon=${point.lon.toFixed(1)}`
    let poll = polls.get(path)
    if (poll === undefined) {
      poll = api.poll<WeatherReport | null>(path, POLL_MS)
      polls.set(path, poll)
    }
    return poll
  }
}

/** Weather at `point`, a steady preview when one is asked for, or null when off or unknown. */
export function useWeather(forecasts: Forecasts, point: GeoPoint, now: number, enabled: boolean): WeatherReport | null {
  const preview = useMemo(() => weatherPreview(), [])
  const poll = enabled && preview === null ? forecasts(point) : IDLE
  const { data } = useSyncExternalStore(poll.subscribe, poll.getSnapshot)
  const previewed = useMemo(() => (preview === null ? null : previewReport(preview, now)), [preview, now])
  if (!enabled) {
    return null
  }
  return previewed ?? data ?? null
}
