import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk'
import { bypassOn, type BypassHours, type BypassState, type Task } from '@seti/shared'
import { audit } from './audit.js'
import { inBackground } from './background.js'
import { PERMISSION_MODE } from './config.js'
import { tasks } from './db.js'
import { refuseAgent } from './ea-guard.js'
import { appendMessage, liveSessions } from './runner.js'
import { bypass } from './store/permissions.js'
import { inLane } from './task-lane.js'

const HOUR_MS = 60 * 60_000

const NOTES = {
  on: (hours: number) =>
    `Bypass on for ${String(hours)} hours: tools run without asking. Seti's guards still refuse dangerous commands.`,
  off: 'Bypass turned off: tool calls go through the usual permission checks again.',
  expired: 'Bypass ended: tool calls go through the usual permission checks again.',
}

/** Expiry timers by task id, each for the end of that agent's Bypass. */
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Switches the agent's open process to the mode; 'next_turn' when it has to restart to take it. */
async function applyLive(taskId: string, mode: PermissionMode): Promise<BypassState['applied']> {
  const session = liveSessions().find(([id]) => id === taskId)?.[1]
  if (session === undefined || session.closed) {
    return 'now'
  }
  const query = session.openQuery
  if (query === null) {
    return 'next_turn'
  }
  return query.setPermissionMode(mode).then(
    () => 'now',
    () => 'next_turn',
  )
}

async function note(task: Task, text: string, on: boolean): Promise<void> {
  if (task.archived_at === null) {
    await inLane(task.id, async () => appendMessage(task.id, { kind: 'seti', payload: { error: text, bypass: on } }))
  }
}

/** Ends the agent's Bypass once `until` passes, unless the user changed it since. */
async function expire(taskId: string, until: string): Promise<void> {
  timers.delete(taskId)
  const task = await tasks.get(taskId)
  if (task === undefined || !(await bypass.end(taskId, until))) {
    return
  }
  await audit.record({
    actor: 'system',
    kind: 'task.bypass_expired',
    subject_type: 'task',
    subject_id: taskId,
    summary: `Bypass of task "${task.title}" ended`,
    detail: { title: task.title, until },
  })
  await applyLive(taskId, PERMISSION_MODE)
  await note(task, NOTES.expired, false)
}

function schedule(taskId: string, until: string | null): void {
  clearTimeout(timers.get(taskId))
  timers.delete(taskId)
  if (until !== null) {
    const run = () => {
      inBackground(`bypass: task ${taskId}`, async () => expire(taskId, until))
    }
    timers.set(taskId, setTimeout(run, Math.max(0, Date.parse(until) - Date.now())).unref())
  }
}

/** Turns Bypass on for `hours`, or off with null; the open process takes it if it can. */
export async function setBypass(task: Task, hours: BypassHours | null): Promise<BypassState> {
  refuseAgent('turn Bypass on or off')
  const until = hours === null ? null : new Date(Date.now() + hours * HOUR_MS).toISOString()
  if (until === null && !bypassOn(task.bypass_until)) {
    await bypass.set(task.id, null)
    schedule(task.id, null)
    return { bypass_until: null, applied: 'now' }
  }
  await bypass.set(task.id, until)
  schedule(task.id, until)
  await audit.record({
    actor: 'user',
    kind: until === null ? 'task.bypass_off' : 'task.bypass_on',
    subject_type: 'task',
    subject_id: task.id,
    summary:
      until === null
        ? `Turned Bypass off for task "${task.title}"`
        : `Turned Bypass on for task "${task.title}" for ${String(hours)} hours`,
    detail: { title: task.title, until, ...(hours === null ? {} : { hours }) },
  })
  const applied = await applyLive(task.id, until === null ? PERMISSION_MODE : 'bypassPermissions')
  await note(task, hours === null ? NOTES.off : NOTES.on(hours), hours !== null)
  return { bypass_until: until, applied }
}

/** Sets each Bypass's expiry timer, and ends each one that ran out while Seti was down. */
export async function resumeBypass(): Promise<void> {
  for (const row of await bypass.all()) {
    if (bypassOn(row.bypass_until)) {
      schedule(row.id, row.bypass_until)
    } else {
      await expire(row.id, row.bypass_until)
    }
  }
}
