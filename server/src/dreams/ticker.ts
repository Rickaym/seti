import type { DreamSettings } from '@seti/shared'
import { audit } from '../audit.js'
import { tasks } from '../db.js'
import { dreamNights, dreamSettings, nightRuns } from '../store/dream-nights.js'
import { dreamGates } from './gates.js'
import { planNight } from './planner.js'
import { stopDream } from './run.js'
import { dreamsOn } from './settings.js'
import { nightBudgetRefusal, startNightly } from './start.js'
import { localDate, nightAt, nightWindow, type WindowSetting } from './window.js'

const TICK_MS = 60_000
/** `dream_gap`: the least time between two nightly dream starts. */
const DREAM_GAP_MS = 2 * 60_000
/** `dream_retry`: how long a dream of an agent at work or waiting on the user waits to try again. */
const DREAM_RETRY_MS = 10 * 60_000
const DAY_MS = 24 * 60 * 60_000

export interface DreamTickDeps {
  now: () => number
  /** The first gate on plan use, host load or free disk that holds dreams back now, or null. */
  gates: () => Promise<string | null>
  start: typeof startNightly
  random?: () => number
}

const windowOf = (settings: DreamSettings & { zone: string }): WindowSetting => ({
  start: settings.window_start,
  end: settings.window_end,
  zone: settings.zone,
})

const zoned = (settings: DreamSettings): (DreamSettings & { zone: string }) | null =>
  settings.zone === null ? null : { ...settings, zone: settings.zone }

/** Ends a night: what still waits is skipped with its last reason, and the night is audited. */
async function endNight(night: string, reason: string): Promise<void> {
  await nightRuns.skipPlanned(night, reason)
  await nightRuns.failTwiceCut(night)
  await dreamNights.end(night)
  const runs = await nightRuns.of(night)
  const states: Record<string, number> = {}
  for (const run of runs) {
    states[run.state] = (states[run.state] ?? 0) + 1
  }
  const cost = runs.reduce((sum, run) => sum + run.cost_usd, 0)
  await audit.record({
    actor: 'system',
    kind: 'dream.night_ended',
    subject_type: 'system',
    summary: `The night of ${night} ended: ${String(states.done ?? 0)} dreams done`,
    detail: { night, ...states, cost_usd: Number(cost.toFixed(4)) },
  })
}

/** Closes open nights whose window ended, and every open night once Dreaming is off. */
async function closeNights(settings: DreamSettings, at: number): Promise<void> {
  for (const open of await dreamNights.open()) {
    if (!settings.enabled) {
      for (const run of await nightRuns.of(open.night)) {
        if (run.kind === 'nightly' && run.state === 'running') {
          stopDream(run.id, 'Dreaming was turned off.')
        }
      }
      await endNight(open.night, 'Dreaming was turned off.')
    } else if (at >= Date.parse(open.window_end)) {
      await endNight(open.night, 'The window ended first.')
    }
  }
}

/** Records once the last night whose whole window passed while Seti was down with Dreaming on. */
async function noteMissed(settings: DreamSettings & { zone: string }, at: number): Promise<void> {
  const setting = windowOf(settings)
  const today = localDate(new Date(at), settings.zone)
  const yesterday = localDate(new Date(at - DAY_MS), settings.zone)
  const night = [today, yesterday].find((date) => nightWindow(date, setting).end.getTime() <= at)
  const saved = await dreamSettings.savedAt()
  if (night === undefined || saved === null) {
    return
  }
  const { start, end } = nightWindow(night, setting)
  if (Date.parse(saved) >= start.getTime() || (await dreamNights.get(night)) !== undefined) {
    return
  }
  const plan = {
    night,
    zone: settings.zone,
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    skipped: {},
  }
  if (await dreamNights.missed(plan)) {
    await audit.record({
      actor: 'system',
      kind: 'dream.night_missed',
      subject_type: 'system',
      summary: `Seti was down for the whole window of the night of ${night}`,
      detail: { night },
    })
  }
}

/** Starts the night's next due dream when the gap, the dreams at once and every gate allow. */
async function startNext(night: string, until: number, settings: DreamSettings, deps: DreamTickDeps): Promise<void> {
  const at = deps.now()
  const { running, lastStart } = await nightRuns.load(night)
  if (running >= settings.at_once || (lastStart !== null && at - Date.parse(lastStart) < DREAM_GAP_MS)) {
    return
  }
  const held = (await deps.gates()) ?? (await nightBudgetRefusal(night, settings))
  if (held !== null) {
    await nightRuns.waiting(night, held)
    return
  }
  for (const planned of await nightRuns.due(night, new Date(at).toISOString())) {
    const task = await tasks.get(planned.task_id)
    if (task === undefined || !(await dreamsOn(task))) {
      await nightRuns.skip(planned.id, 'The agent was switched out of Dreaming.')
      continue
    }
    const refusal = await deps.start(task, planned, settings, until)
    if (refusal === null) {
      return
    }
    await (refusal.wait
      ? nightRuns.defer(planned.id, new Date(at + DREAM_RETRY_MS).toISOString(), refusal.text)
      : nightRuns.skip(planned.id, refusal.text))
  }
}

/**
 * One tick of the nightly schedule. Inside the window it plans the night once, plans again once
 * the dreams a restart or a turn cut, and starts the next due dream; outside it, it closes the
 * night that ended and records a night Seti missed. Every step reads the database, so a restart
 * or a deploy picks up where the last process left off.
 */
export async function dreamTick(deps: DreamTickDeps): Promise<void> {
  const settings = await dreamSettings.get()
  await closeNights(settings, deps.now())
  const named = zoned(settings)
  if (!settings.enabled || named === null) {
    return
  }
  const at = deps.now()
  const night = nightAt(new Date(at), windowOf(named))
  if (night === null) {
    await noteMissed(named, at)
    return
  }
  const { start, end } = nightWindow(night, windowOf(named))
  const planned = await planNight({
    night,
    settings: named,
    start,
    end,
    at: new Date(at),
    ...(deps.random === undefined ? {} : { random: deps.random }),
  })
  if (!planned) {
    await nightRuns.retryCut(night, new Date(at + DREAM_GAP_MS).toISOString())
  }
  await startNext(night, end.getTime(), settings, deps)
}

let ticking: Promise<void> | null = null

/** Ticks the nightly schedule every minute; a tick still going is not doubled. */
export function startDreamTicker(): void {
  const tick = () => {
    ticking ??= dreamTick({ now: Date.now, gates: dreamGates, start: startNightly })
      .catch((e: unknown) => {
        process.stderr.write(`dreams: the nightly tick failed: ${e instanceof Error ? e.message : String(e)}\n`)
      })
      .finally(() => {
        ticking = null
      })
  }
  setInterval(tick, TICK_MS).unref()
}
