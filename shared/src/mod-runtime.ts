import { z } from 'zod'
import { MOD_TASK_EVENTS } from './mod-contributions.js'
import type { ModCapability, ModCapabilityName } from './mods.js'

const KB = 1024
const MB = 1024 * KB
const MINUTE_MS = 60_000

/** What third-party mod logic may use, per event and per mod; Settings and tests read them too. */
export const MOD_LIMITS = {
  memoryBytes: 32 * MB,
  stackBytes: 512 * KB,
  cpuSliceMs: 500,
  cpuTotalMs: 5000,
  wallMs: 10_000,
  scheduleWallMs: 30_000,
  /** Past the wall time, the pool waits this long before it kills the child. */
  wallGraceMs: 2000,
  callsPerEvent: 50,
  fetchesPerEvent: 10,
  fetchTimeoutMs: 15_000,
  fetchResponseBytes: MB,
  fetchEventBytes: 4 * MB,
  fetchBodyBytes: 64 * KB,
  callArgsBytes: 64 * KB,
  callResultBytes: MB,
  outputBytes: 64 * KB,
  logLines: 50,
  logLineChars: 500,
  logKeptLines: 500,
  /** One NDJSON line between Seti and the runner child. */
  lineBytes: 2 * MB,
  logicBytes: 512 * KB,
  eventsPerMinute: 60,
  queuePerMod: 20,
  dailyCpuMs: 600_000,
  failuresBeforeBackoff: 5,
  backoffMaxMs: 60 * MINUTE_MS,
  failuresPerHourTurnsOff: 20,
  childRssBytes: 160 * MB,
  workersMin: 1,
  workersMax: 3,
  webhookBodyBytes: MB,
  webhookItems: 100,
  storageValueBytes: 64 * KB,
  storageModBytes: MB,
  storageKeyChars: 200,
  storageKeysListed: 500,
  chatChars: 4000,
  chatPerEvent: 3,
  chatPerHour: 30,
  notifyPerEvent: 3,
  notifyPerHour: 10,
  notifyTitleChars: 120,
  notifyBodyChars: 240,
  statusChars: 40,
  transcriptEntries: 50,
  transcriptBytes: 256 * KB,
  fileBytes: 512 * KB,
  openAsks: 3,
  askTtlMs: 10 * MINUTE_MS,
  auditDetailBytes: 2 * KB,
  refusalsAudited: 20,
  refusalWindowMs: 10 * MINUTE_MS,
} as const

/** Who started an event; informational only, since grants never depend on it. */
export const MOD_CALLERS = ['user', 'ea', 'agent', 'view', 'webhook', 'schedule', 'task', 'user-allowed'] as const
export type ModCaller = (typeof MOD_CALLERS)[number]

/** Every call mod logic can make into Seti and the capability it needs; nothing else is reachable. */
export const MOD_OPS = {
  'settings.get': null,
  'audit.record': null,
  'status.set': null,
  'storage.get': 'storage',
  'storage.keys': 'storage',
  'storage.set': 'storage',
  'storage.delete': 'storage',
  'notify.send': 'notify',
  'net.fetch': 'net.fetch',
  'connection.fetch': 'connection',
  'tasks.list': 'tasks.read',
  'tasks.get': 'tasks.read',
  'tasks.transcript': 'tasks.read',
  'tasks.prs': 'tasks.read',
  'tasks.manage.rename': 'tasks.manage',
  'tasks.manage.pin': 'tasks.manage',
  'tasks.manage.set_color': 'tasks.manage',
  'tasks.manage.link_pr': 'tasks.manage',
  'tasks.manage.unlink_pr': 'tasks.manage',
  'tasks.manage.start': 'tasks.manage',
  'tasks.manage.stop': 'tasks.manage',
  'chat.post': 'chat.post',
  'chat.post.direct': 'chat.post',
  'files.list': 'files.read',
  'files.read': 'files.read',
} as const satisfies Record<string, ModCapabilityName | null>
export type ModOp = keyof typeof MOD_OPS
export const MOD_OP_NAMES = Object.keys(MOD_OPS) as ModOp[]

const id = z.string().min(1).max(100)
const name = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9_-]*$/)
const storageKey = z.string().min(1).max(MOD_LIMITS.storageKeyChars)
const fetchRequest = {
  url: z.string().max(4000),
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string().max(100), z.string().max(8000)).optional(),
  body: z.string().max(MOD_LIMITS.fetchBodyBytes).optional(),
}

/**
 * The arguments of each op, exactly as the logic prelude sends them; a key the schema does not
 * name, such as a mod id, fails. Limits that need Seti's data (sizes in storage, scopes) are the
 * op's own checks.
 */
export const MOD_OP_ARGS = {
  'settings.get': z.strictObject({}),
  'audit.record': z.strictObject({
    kind: name,
    summary: z.string().min(1).max(300),
    detail: z.record(z.string().max(100), z.unknown()).optional(),
  }),
  'status.set': z.strictObject({ item: name, text: z.string().max(MOD_LIMITS.statusChars), icon: name.optional() }),
  'storage.get': z.strictObject({ key: storageKey }),
  'storage.keys': z.strictObject({ prefix: z.string().max(MOD_LIMITS.storageKeyChars).optional() }),
  'storage.set': z.strictObject({ key: storageKey, value: z.json() }),
  'storage.delete': z.strictObject({ key: storageKey }),
  'notify.send': z.strictObject({
    kind: name,
    title: z.string().min(1).max(MOD_LIMITS.notifyTitleChars),
    body: z.string().max(MOD_LIMITS.notifyBodyChars).optional(),
    url: z.string().max(2000).optional(),
  }),
  'net.fetch': z.strictObject(fetchRequest),
  'connection.fetch': z.strictObject({
    ...fetchRequest,
    connection: z
      .string()
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/),
  }),
  'tasks.list': z.strictObject({
    status: z.string().max(40).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  'tasks.get': z.strictObject({ id }),
  'tasks.transcript': z.strictObject({
    id,
    limit: z.number().int().min(1).max(MOD_LIMITS.transcriptEntries).optional(),
    before: z.string().max(100).optional(),
  }),
  'tasks.prs': z.strictObject({ id }),
  'tasks.manage.rename': z.strictObject({ id, title: z.string().trim().min(1).max(200) }),
  'tasks.manage.pin': z.strictObject({ id, on: z.boolean() }),
  'tasks.manage.set_color': z.strictObject({ id, color: z.string().max(40).nullable() }),
  'tasks.manage.link_pr': z.strictObject({ id, url: z.string().max(2000) }),
  'tasks.manage.unlink_pr': z.strictObject({ id, url: z.string().max(2000) }),
  'tasks.manage.start': z.strictObject({
    title: z.string().trim().min(1).max(200),
    prompt: z.string().min(1).max(20_000),
    repo: z.string().max(200).optional(),
  }),
  'tasks.manage.stop': z.strictObject({ id }),
  'chat.post': z.strictObject({ text: z.string().min(1).max(MOD_LIMITS.chatChars) }),
  'chat.post.direct': z.strictObject({
    text: z.string().min(1).max(MOD_LIMITS.chatChars),
    to: z.string().min(1).max(100),
  }),
  'files.list': z.strictObject({ agentId: id, dir: z.string().max(1000) }),
  'files.read': z.strictObject({ agentId: id, path: z.string().min(1).max(1000) }),
} as const satisfies Record<ModOp, z.ZodType>
export type ModOpArgs<O extends ModOp> = z.output<(typeof MOD_OP_ARGS)[O]>

/** Ops that reach the network; they count toward fetchesPerEvent as well as callsPerEvent. */
export const MOD_FETCH_OPS: readonly ModOp[] = ['net.fetch', 'connection.fetch']

/** The code on the Error a refused or failed call throws in the mod; asked: it waits for the user. */
export const MOD_ERROR_CODES = ['denied', 'invalid', 'limit', 'asked', 'failed', 'busy'] as const
export type ModErrorCode = (typeof MOD_ERROR_CODES)[number]

export const modError = z.strictObject({ code: z.enum(MOD_ERROR_CODES), message: z.string().max(2000) })
export type ModError = z.output<typeof modError>

type Scope<K extends ModCapabilityName> = Extract<ModCapability, { name: K }>

/** What each granted capability covers; connection carries the connection the user bound to it. */
export type ModGrantScopes = {
  readonly [K in ModCapabilityName]?: K extends 'connection' ? Scope<K> & { connectionId: string | null } : Scope<K>
}

/** The informational context a handler receives, frozen. */
export const modEventContext = z.strictObject({
  eventId: z.string().min(1).max(64),
  mod: z.strictObject({ id: z.string().max(40), version: z.string().max(20) }),
  caller: z.enum(MOD_CALLERS),
  agentId: z.string().max(100).optional(),
})
export type ModEventContext = z.output<typeof modEventContext>

const json = z.unknown()

/** One event for a mod's logic, by the handler it fires. */
export const modEvent = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('command'), command: z.string().max(40), args: json }),
  z.strictObject({
    kind: z.literal('webhook'),
    sourceId: z.string().max(40),
    headers: z.record(z.string().max(100), z.string().max(4000)),
    body: z.string(),
    receivedAt: z.string(),
  }),
  z.strictObject({
    kind: z.literal('schedule'),
    scheduleId: z.string().max(40),
    since: z.string().nullable(),
    now: z.string(),
  }),
  z.strictObject({
    kind: z.literal('task'),
    type: z.enum(MOD_TASK_EVENTS),
    taskId: z.string().max(100),
    at: z.string(),
  }),
])
export type ModEvent = z.output<typeof modEvent>

/** The limits Seti sends the runner with each event. */
export const modEngineLimits = z.strictObject({
  memoryBytes: z.number().int().positive(),
  cpuSliceMs: z.number().int().positive(),
  cpuTotalMs: z.number().int().positive(),
  wallMs: z.number().int().positive(),
  calls: z.number().int().nonnegative(),
  callArgsBytes: z.number().int().positive(),
  outputBytes: z.number().int().positive(),
  logLines: z.number().int().nonnegative(),
  logLineChars: z.number().int().positive(),
})
export type ModEngineLimits = z.output<typeof modEngineLimits>

/** Seti to the runner child, one JSON line each: run an event, or answer one of its calls. */
export const modParentMessage = z.union([
  z.strictObject({
    type: z.literal('event'),
    eventId: z.string().min(1).max(64),
    /** The package hash the script was verified against. */
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    script: z.string(),
    event: modEvent,
    ctx: modEventContext,
    limits: modEngineLimits,
  }),
  z.strictObject({ type: z.literal('reply'), callId: z.number().int().positive(), ok: z.literal(true), value: json }),
  z.strictObject({
    type: z.literal('reply'),
    callId: z.number().int().positive(),
    ok: z.literal(false),
    error: modError,
  }),
])
export type ModParentMessage = z.output<typeof modParentMessage>

const usage = z.strictObject({ cpuMs: z.number().nonnegative(), calls: z.number().int().nonnegative() })
const logs = z.array(z.string())

/** The runner child to Seti: ready once QuickJS loaded, a call out of the engine, or an event end. */
export const modChildMessage = z.union([
  z.strictObject({ type: z.literal('ready') }),
  z.strictObject({
    type: z.literal('call'),
    eventId: z.string().min(1).max(64),
    callId: z.number().int().positive(),
    op: z.string().max(40),
    args: json,
  }),
  z.strictObject({ type: z.literal('done'), eventId: z.string(), ok: z.literal(true), value: json, logs, usage }),
  z.strictObject({
    type: z.literal('done'),
    eventId: z.string(),
    ok: z.literal(false),
    error: modError,
    logs,
    usage,
    /** The engine itself failed, so the child retires after this event. */
    aborted: z.boolean().optional(),
  }),
])
export type ModChildMessage = z.output<typeof modChildMessage>

/** One line of a mod's own log, as Settings, Mods, Log shows it. */
export interface ModLogLine {
  at: string
  event_id: string | null
  kind: 'log' | 'error' | 'refused' | 'system'
  level: 'info' | 'warn' | 'error'
  line: string
}

/** How a mod's logic is doing, for its card in Settings, Mods and the EA's list_mods. */
export type ModRunStatus = 'ok' | 'erroring' | 'paused' | 'off'

/** A status bar item a running third-party mod set from its logic, for the status bar to show. */
export interface ModStatusItemInfo {
  /** `<mod>.<item>`. */
  key: string
  mod: string
  modName: string
  title: string
  text: string
  /** The mod's own command the item runs when pressed, if it names one. */
  command: string | null
}

/** What running third-party mods show in Seti's own chrome. */
export interface ModLiveInfo {
  status: ModStatusItemInfo[]
}

/** A third-party mod's theme tokens, as Seti rebuilt them from the checked file. */
export interface ModThemeTokensInfo {
  css: string
}
