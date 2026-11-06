import { randomUUID } from 'node:crypto'
import { MOD_LIMITS, type ModEvent } from '@seti/shared'
import type { ModEventResult } from './child.js'
import {
  dispatchModOp,
  EventCounters,
  UNAVAILABLE_OPS,
  type ModEventRun,
  type OpReply,
  type OpTable,
} from './dispatch.js'
import { createModEvents, type ModEventOrigin, type ModLogicTarget } from './events.js'
import { createModLogicPool } from './pool.js'
import { scheduleMod, type ModSchedule } from './schedule.js'
import { audit } from '../../audit.js'
import { MOD_WORKERS } from '../../config.js'
import { now } from '../../db.js'
import { mayAuditRefusal } from '../../rate-limit.js'
import { modLogs, modUsage, type ModLogEntry } from '../../store/mod-logic.js'

/** What the mod host gives the logic runtime: which mods run now, and how Seti stops one. */
export interface ModLogicHost {
  /** The mod's verified script and grants, or null when it is off or held by safe mode. */
  target: (modId: string) => Promise<ModLogicTarget | null>
  /** Turns the mod off as Seti, audited, and tells the user. */
  turnOff: (target: ModLogicTarget, reason: string) => Promise<void>
  /** Tells the user once that the mod paused itself until midnight. */
  paused: (target: ModLogicTarget, reason: string) => Promise<void>
}

const NO_HOST: ModLogicHost = {
  target: async () => Promise.resolve(null),
  turnOff: async () => Promise.resolve(),
  paused: async () => Promise.resolve(),
}

/** A local calendar day, YYYY-MM-DD, as mod_usage counts compute. */
export function localDay(at: number): string {
  const date = new Date(at)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const clip = (line: string) =>
  line.length <= MOD_LIMITS.logLineChars ? line : `${line.slice(0, MOD_LIMITS.logLineChars - 3)}...`

const eventName = (event: ModEvent): string => {
  switch (event.kind) {
    case 'command':
      return `command ${event.command}`
    case 'webhook':
      return `webhook ${event.sourceId}`
    case 'schedule':
      return `schedule ${event.scheduleId}`
    case 'task':
      return `task event ${event.type}`
  }
}

/** The event's lines for the mod's log; every text was cleaned of secrets on the way out. */
function logEntries(event: ModEvent, result: ModEventResult): ModLogEntry[] {
  const lines: ModLogEntry[] = result.logs.map((line) => ({ kind: 'log', level: 'info', line: clip(line) }))
  for (const line of result.refused) {
    lines.push({ kind: 'refused', level: 'warn', line: clip(line) })
  }
  if (!result.ok) {
    const quiet = !ran(result)
    const line = clip(`The ${eventName(event)} failed: ${result.error.message}`)
    lines.push(quiet ? { kind: 'system', level: 'warn', line } : { kind: 'error', level: 'error', line })
  }
  return lines
}

/** Busy and denied results never reached a runner, so they use no compute. */
const ran = (result: ModEventResult) => result.ok || (result.error.code !== 'busy' && result.error.code !== 'denied')

let ops: OpTable = UNAVAILABLE_OPS
let host: ModLogicHost = NO_HOST

/** Records a denied call as the mod, at most 20 per mod in 10 minutes. */
async function auditDenied(run: ModEventRun, op: string, message: string): Promise<void> {
  if (!mayAuditRefusal(`mod:${run.modId}`)) {
    return
  }
  await audit.record({
    actor: 'user',
    kind: 'mod.call_refused',
    subject_type: 'mod',
    subject_id: run.modId,
    summary: `Refused ${op} for ${run.modId}: ${message}`,
    detail: { op, event_id: run.eventId },
  })
}

const dispatchDeps = () => ({ ops, denied: auditDenied })

async function record(target: ModLogicTarget, event: ModEvent, result: ModEventResult): Promise<void> {
  if (ran(result)) {
    await modUsage.add(target.modId, localDay(Date.now()), result.usage.cpuMs, !result.ok)
  }
  await modLogs.append(target.modId, null, now(), logEntries(event, result))
}

/** The logic runtime: a pool of locked-down children, the op dispatcher and per-mod queues. */
function createModLogic(size: number) {
  const pool = createModLogicPool({
    size,
    dispatch: async (event, op, args) => dispatchModOp(dispatchDeps(), event, op, args),
  })
  const events = createModEvents({
    run: pool.run,
    concurrency: size,
    target: async (modId) => host.target(modId),
    record,
    usedToday: async (modId) => modUsage.cpuOn(modId, localDay(Date.now())),
    turnOff: async (target, reason) => host.turnOff(target, reason),
    paused: async (target, reason) => host.paused(target, reason),
  })
  return { fire: events.fire, events, close: pool.close }
}

let logic: ReturnType<typeof createModLogic> | null = null

const modLogic = () => (logic ??= createModLogic(MOD_WORKERS))

/** Plugs in the op table and the mod host; until then every op refuses and no mod runs. */
export function connectModLogic(parts: { ops?: OpTable; host?: ModLogicHost }): void {
  ops = parts.ops ?? ops
  host = parts.host ?? host
}

/** Runs one of a mod's commands, from the palette, an agent, the EA or a view. */
export const runCommandEvent = async (modId: string, command: string, args: unknown, origin: ModEventOrigin) =>
  modLogic().fire(modId, { kind: 'command', command, args }, origin)

/** Fires a webhook, schedule or task event; a busy result means it did not run. */
export const fireModEvent = async (modId: string, event: ModEvent, origin: ModEventOrigin) =>
  modLogic().fire(modId, event, origin)

/** Fires a mod's schedules until the returned function is called, as the mod is activated. */
export const scheduleModEvents = (modId: string, schedules: readonly ModSchedule[]): (() => void) =>
  scheduleMod(modId, schedules, modLogic().events)

/**
 * Runs one op outside an event, as the mod with its own grants, such as a view's storage call.
 * The caller decides which ops it offers; this only runs them as logic's calls run.
 */
export async function runModOp(modId: string, op: string, args: unknown, origin: ModEventOrigin): Promise<OpReply> {
  const target = await host.target(modId)
  if (target === null) {
    return { ok: false, error: { code: 'denied', message: `The mod ${modId} is off` } }
  }
  const run = { modId, grants: target.grants, scopes: target.scopes, eventId: randomUUID(), caller: origin.caller }
  return dispatchModOp(dispatchDeps(), { run, counters: new EventCounters() }, op, args)
}

/** Stops every mod runner, as Seti shuts down. */
export function stopModLogic(): void {
  logic?.close()
  logic = null
}
