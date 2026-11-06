import {
  MOD_FETCH_OPS,
  MOD_LIMITS,
  MOD_OP_ARGS,
  MOD_OPS,
  type ModCaller,
  type ModCapabilityName,
  type ModError,
  type ModErrorCode,
  type ModGrantScopes,
  type ModOp,
  type ModOpArgs,
} from '@seti/shared'
import { asMod } from '../../access.js'
import { HttpError } from '../../http.js'
import { redactValues } from '../../pollers/fetch.js'
import { redactSecrets } from '../../scrub.js'

/** The event a call belongs to, as Seti dispatched it; the child supplies none of it. */
export interface ModEventRun {
  modId: string
  grants: readonly ModCapabilityName[]
  scopes: ModGrantScopes
  eventId: string
  caller: ModCaller
}

/** What an op learns of its call besides its arguments; the request source is already the mod. */
interface OpCall {
  run: ModEventRun
  /** Marks a value, such as a connection's, that must never reach the mod's log or errors. */
  secret: (value: string) => void
}

type OpHandler<O extends ModOp> = (args: ModOpArgs<O>, call: OpCall) => Promise<unknown>

/** One handler per op in MOD_OPS; chunk B's ops fill it, tests use fakes. */
export type OpTable = { readonly [O in ModOp]: OpHandler<O> }

export type OpReply = { ok: true; value: unknown } | { ok: false; error: ModError }

/** What one event has used so far, counted in Seti whatever the child counts. */
export class EventCounters {
  calls = 0
  fetches = 0
  /** Values to take out of anything the event's log or errors carry. */
  readonly secrets: string[] = []
  /** One line per refused call, for the mod's log. */
  readonly refused: string[] = []

  /** Counts one call; returns why it is over a limit, or null. */
  count(op: ModOp): string | null {
    this.calls += 1
    if (this.calls > MOD_LIMITS.callsPerEvent) {
      return `An event makes at most ${String(MOD_LIMITS.callsPerEvent)} calls into Seti`
    }
    if (MOD_FETCH_OPS.includes(op)) {
      this.fetches += 1
      if (this.fetches > MOD_LIMITS.fetchesPerEvent) {
        return `An event makes at most ${String(MOD_LIMITS.fetchesPerEvent)} requests`
      }
    }
    return null
  }
}

/** One event as the dispatcher sees it: what Seti dispatched, and what it has used. */
export interface EventCall {
  run: ModEventRun
  counters: EventCounters
}

export interface DispatchDeps {
  ops: OpTable
  /** A call refused as denied, run as the mod; Seti audits a capped number of them. */
  denied: (run: ModEventRun, op: string, message: string) => Promise<void>
}

const ERROR_CHARS = 500

/** An op that answers every call with denied, until the op table is filled. */
const unavailable = async (): Promise<never> => {
  await Promise.resolve()
  throw new HttpError(403, 'This call is not available to mods yet')
}

/** The table before any op exists: every op refuses. */
export const UNAVAILABLE_OPS: OpTable = Object.fromEntries(
  (Object.keys(MOD_OPS) as ModOp[]).map((op) => [op, unavailable]),
) as unknown as OpTable

const refuse = (code: ModErrorCode, message: string): OpReply => ({ ok: false, error: { code, message } })

function codeOf(status: number): ModErrorCode {
  if (status === 401 || status === 403) {
    return 'denied'
  }
  if (status === 400 || status === 422) {
    return 'invalid'
  }
  if (status === 413 || status === 429) {
    return 'limit'
  }
  return status === 409 || status === 503 ? 'busy' : 'failed'
}

/** Takes secrets and values out of a text that goes back into the mod or its log. */
export const cleanText = (text: string, counters: EventCounters): string =>
  redactSecrets(redactValues(text, counters.secrets)).slice(0, ERROR_CHARS)

const isOp = (op: string): op is ModOp => Object.hasOwn(MOD_OPS, op)

function failure(e: unknown, counters: EventCounters): OpReply {
  if (e instanceof HttpError) {
    return refuse(codeOf(e.status), cleanText(e.message, counters))
  }
  return refuse('failed', cleanText(e instanceof Error ? e.message : String(e), counters))
}

const sourceOf = (run: ModEventRun) => ({
  id: run.modId,
  grants: run.grants,
  scopes: run.scopes,
  eventId: run.eventId,
  caller: run.caller,
})

/** Checks what Seti can check before the op runs: the op is within the counts and granted. */
function precheck({ run, counters }: EventCall, op: ModOp): OpReply | null {
  const capability = MOD_OPS[op]
  const over = counters.count(op)
  if (over !== null) {
    return refuse('limit', over)
  }
  return capability !== null && !run.grants.includes(capability)
    ? refuse('denied', `${run.modId} was not granted ${capability}`)
    : null
}

/**
 * Runs one call from a mod's logic: refuses unknown ops, ops past the event's counters and args
 * the op's strict schema refuses, then runs the op as the mod and caps what goes back. Refusals
 * go to the mod's log, and denials to the audit log under its cap.
 */
export async function dispatchModOp(deps: DispatchDeps, event: EventCall, op: string, args: unknown): Promise<OpReply> {
  const { run, counters } = event
  const reply = await answer(deps.ops, event, op, args)
  if (!reply.ok && reply.error.code !== 'asked' && reply.error.code !== 'failed') {
    const name = op.slice(0, 40)
    counters.refused.push(`Refused ${name}: ${reply.error.message}`)
    if (reply.error.code === 'denied') {
      await asMod(sourceOf(run), async () => deps.denied(run, name, reply.error.message))
    }
  }
  return reply
}

async function answer(table: OpTable, event: EventCall, op: string, args: unknown): Promise<OpReply> {
  const { run, counters } = event
  if (!isOp(op)) {
    return refuse('denied', `Mods cannot call ${op.slice(0, 40)}`)
  }
  const refused = precheck(event, op)
  if (refused !== null) {
    return refused
  }
  const parsed = MOD_OP_ARGS[op].safeParse(args)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
    return refuse('invalid', `${op} refused its arguments: ${where}${issue?.message ?? 'invalid'}`)
  }
  const handler = table[op] as OpHandler<ModOp>
  const call: OpCall = {
    run,
    secret: (value) => {
      counters.secrets.push(value)
    },
  }
  try {
    const value = await asMod(sourceOf(run), async () => handler(parsed.data as ModOpArgs<ModOp>, call))
    const json = JSON.stringify(value ?? null)
    if (Buffer.byteLength(json) > MOD_LIMITS.callResultBytes) {
      return refuse('limit', `The answer to ${op} is over ${String(MOD_LIMITS.callResultBytes / 1024 / 1024)} MB`)
    }
    const escaped = counters.secrets.map((secret) => JSON.stringify(secret).slice(1, -1))
    return { ok: true, value: JSON.parse(redactValues(json, escaped)) as unknown }
  } catch (e) {
    return failure(e, counters)
  }
}
