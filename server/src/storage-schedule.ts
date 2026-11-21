import type { StorageSchedule, StorageScheduleChange, Task } from '@seti/shared'
import { audit } from './audit.js'
import { now, tasks } from './db.js'
import { refuseDelegates } from './ea-guard.js'
import { cleanAgent, cleanRefusal } from './storage-clean.js'
import { storageSettings } from './store/storage.js'

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_MS = 60 * 60 * 1000
const SWEEP_DELAY_MS = 5 * 60 * 1000

/** Changes the automatic clean as the user, audited; the EA, agents and mods are refused. */
export async function updateStorageSchedule(input: StorageScheduleChange): Promise<StorageSchedule> {
  refuseDelegates('change the automatic clean')
  const current = await storageSettings.get()
  const next = { enabled: input.enabled ?? current.enabled, idle_days: input.idle_days ?? current.idle_days }
  await storageSettings.set(next)
  const state = next.enabled ? `on, for agents idle ${String(next.idle_days)}+ days` : 'off'
  await audit.record({
    actor: 'user',
    kind: 'system.storage_schedule_changed',
    subject_type: 'system',
    summary: `Turned the automatic clean of rebuildable folders ${state}`,
    detail: { enabled: next.enabled, idle_days: next.idle_days },
  })
  return storageSettings.get()
}

/** An agent the schedule cleans: archived, or idle past the cutoff, and never one that runs. */
export const dueForClean = (task: Task, cutoff: string): boolean =>
  cleanRefusal(task) === null && (task.archived_at !== null || task.updated_at < cutoff)

/** Cleans the rebuildable folders of every agent due, as the system, and records what it freed. */
export async function sweepIdleClean(at = Date.now()): Promise<number> {
  const schedule = await storageSettings.get()
  if (!schedule.enabled) {
    return 0
  }
  const cutoff = new Date(at - schedule.idle_days * DAY_MS).toISOString()
  let freed = 0
  for (const task of (await tasks.listAll()).filter((candidate) => dueForClean(candidate, cutoff))) {
    const reason = task.archived_at === null ? `idle ${String(schedule.idle_days)}+ days` : 'archived'
    try {
      freed += (await cleanAgent(task, { actor: 'system', reason: `automatic clean, ${reason}` })).freed_bytes
    } catch (e) {
      process.stderr.write(`storage: could not clean ${task.id}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
  await storageSettings.ran(now(), freed)
  return freed
}

let sweeping: Promise<number> | null = null

export function startStorageSchedule(): void {
  const run = () => {
    sweeping ??= sweepIdleClean()
      .catch((e: unknown) => {
        process.stderr.write(`storage: automatic clean failed: ${e instanceof Error ? e.message : String(e)}\n`)
        return 0
      })
      .finally(() => {
        sweeping = null
      })
  }
  setTimeout(run, SWEEP_DELAY_MS).unref()
  setInterval(run, SWEEP_MS).unref()
}
