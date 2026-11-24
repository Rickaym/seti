import type { DreamNight } from '@seti/shared'
import { dreamNights, nightRuns } from '../store/dream-nights.js'

/** The newest night that was planned or on which a dream ran. */
async function newest(): Promise<string | null> {
  const [planned, ran] = await Promise.all([dreamNights.latest(), nightRuns.latestNight()])
  const nights = [planned?.night, ran].filter((night): night is string => night !== undefined && night !== null)
  return nights.toSorted((a, b) => a.localeCompare(b, 'en')).at(-1) ?? null
}

/**
 * A night with its dreams and what they cost, the newest one when none is named. A day on which
 * only Dream now ran has no window and is `manual`; null when nothing happened that night.
 */
export async function dreamNight(name: string | undefined): Promise<DreamNight | null> {
  const night = name ?? (await newest())
  if (night === null) {
    return null
  }
  const [row, runs] = await Promise.all([dreamNights.get(night), nightRuns.of(night)])
  if (row === undefined && runs.length === 0) {
    return null
  }
  const plan = row ?? { night, zone: null, window_start: null, window_end: null, state: 'manual' as const, skipped: {} }
  return { ...plan, runs, cost_usd: runs.reduce((sum, run) => sum + run.cost_usd, 0) }
}
