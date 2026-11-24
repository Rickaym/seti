import type { DreamSettings, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { tasks } from '../db.js'
import { dreamsOf } from '../runtimes/capabilities.js'
import { activitySinceLastDream, dreamNights, dreamOptOuts, type PlannedDream } from '../store/dream-nights.js'
import { sandboxPolicy } from '../store/sandbox.js'
import { dreamLimits } from './start.js'

/** The most a planned dream's start is moved past the window's start, so starts spread out. */
const JITTER_MS = 2 * 60_000

/** Why an agent is left out of a night when it is planned, or null when it is planned. */
type PlanSkip = 'opted_out' | 'not_sandboxed' | 'no_memory' | 'nothing_new'

export interface NightToPlan {
  night: string
  settings: DreamSettings & { zone: string }
  start: Date
  end: Date
  at: Date
  random?: () => number
}

interface Facts {
  off: Awaited<ReturnType<typeof dreamOptOuts.get>>
  sandboxed: boolean
  activity: Map<string, number>
}

function skipOf(task: Task, facts: Facts): PlanSkip | null {
  if (facts.off.tasks.has(task.id) || facts.off.workspaces.has(task.workspace_id)) {
    return 'opted_out'
  }
  if (!facts.sandboxed || !task.sandbox) {
    return 'not_sandboxed'
  }
  if (dreamsOf(task.runtime) === null) {
    return 'no_memory'
  }
  return (facts.activity.get(task.id) ?? 0) > 0 ? null : 'nothing_new'
}

/**
 * Plans a night once: one dream for each unarchived agent switched in, sandboxed, with a
 * runtime that keeps memory and something new since its last dream, the busiest first, each a
 * little after the last. Whether an agent is at work or waits on the user is checked when its
 * turn comes. False when the night was planned before.
 */
export async function planNight(input: NightToPlan): Promise<boolean> {
  const live = (await tasks.listAll()).filter((task) => task.archived_at === null)
  const facts: Facts = {
    off: await dreamOptOuts.get(),
    sandboxed: (await sandboxPolicy.get()).enabled,
    activity: await activitySinceLastDream(live.map((task) => task.id)),
  }
  const skipped: Record<string, number> = {}
  const chosen: Task[] = []
  for (const task of live) {
    const skip = skipOf(task, facts)
    if (skip === null) {
      chosen.push(task)
    } else {
      skipped[skip] = (skipped[skip] ?? 0) + 1
    }
  }
  chosen.sort((a, b) => (facts.activity.get(b.id) ?? 0) - (facts.activity.get(a.id) ?? 0))
  const random = input.random ?? Math.random
  const offsets = chosen.map(() => Math.floor(random() * JITTER_MS)).sort((a, b) => a - b)
  const from = Math.max(input.start.getTime(), input.at.getTime())
  const dreams: PlannedDream[] = chosen.map((task, i) => ({
    task_id: task.id,
    not_before: new Date(from + (offsets[i] ?? 0)).toISOString(),
    model: dreamLimits(task, input.settings).model,
  }))
  const plan = {
    night: input.night,
    zone: input.settings.zone,
    window_start: input.start.toISOString(),
    window_end: input.end.toISOString(),
    skipped,
  }
  if (!(await dreamNights.plan(plan, dreams))) {
    return false
  }
  await audit.record({
    actor: 'system',
    kind: 'dream.night_planned',
    subject_type: 'system',
    summary: `Planned ${String(dreams.length)} dreams for the night of ${input.night}`,
    detail: {
      night: input.night,
      planned: dreams.length,
      ...Object.fromEntries(Object.entries(skipped).map(([reason, count]) => [`skipped_${reason}`, count])),
    },
  })
  return true
}
