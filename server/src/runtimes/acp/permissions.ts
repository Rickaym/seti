import { askedCall, type ToolCall, type ToolKind } from '@seti/shared'
import { z } from 'zod'
import type { JsonRpc } from '../json-rpc.js'

/** How Seti answers a call the agent asks about: run it, or refuse it with a reason. */
type AcpVerdict = { allow: true; input?: Record<string, unknown> } | { allow: false; message: string }

/** Seti's decision on one call, until the signal aborts because the agent no longer waits. */
export type AcpDecide = (call: ToolCall, signal: AbortSignal) => Promise<AcpVerdict>

const request = z.looseObject({
  options: z.array(z.looseObject({ optionId: z.string(), kind: z.string() })),
  toolCall: z.unknown(),
})

/** The only option kinds Seti picks: never one that allows or rejects for the rest of the session. */
const ONCE = { allow: 'allow_once', reject: 'reject_once' } as const

const CANCELLED = { outcome: { outcome: 'cancelled' } }

type Options = z.infer<typeof request>['options']

/** The reply for a verdict: the option of the one-time kind it names, or cancelled without one. */
function replyOf(options: Options, allow: boolean): unknown {
  const kind = allow ? ONCE.allow : ONCE.reject
  const option = options.find((each) => each.kind === kind)
  if (option === undefined) {
    return allow ? replyOf(options, false) : CANCELLED
  }
  return { outcome: { outcome: 'selected', optionId: option.optionId } }
}

/** What answering an agent's permission requests needs from its session. */
interface PermissionContext {
  rpc: JsonRpc
  decide: AcpDecide
  /** Seti's own tool servers, whose calls Seti decides in its relay on the arguments they run with. */
  relayed: ReadonlySet<string>
  /** Seti refused this call: the update that ends it is stored as denied. */
  refused: (callId: string) => void
}

/**
 * Kinds whose request shows what will run: a command as it runs, an edit's path and text, the
 * paths a read or search covers. A fetch shows a title cut short, and other kinds only a title.
 */
const READABLE: ReadonlySet<ToolKind> = new Set(['shell', 'edit', 'read', 'search'])

/**
 * How a request is answered without Seti's decision, or null when Seti decides it. A call to one
 * of Seti's own tool servers goes on, because the relay decides it on the arguments it receives
 * before it runs; any other server's call, and a call of a kind whose request does not show what
 * will run, is refused, so Seti never allows what it could not read.
 */
function undecided(call: ToolCall, relayed: ReadonlySet<string>): boolean | null {
  if (call.kind === 'mcp') {
    return call.mcp !== undefined && relayed.has(call.mcp.server)
  }
  return READABLE.has(call.kind) ? null : false
}

/**
 * An ACP agent's permission requests: each goes to Seti's decision, which may take as long as the
 * user takes, and is answered once, for this call only. A request the turn no longer waits for,
 * as after a cancel, is answered cancelled and aborts its decision.
 */
export class Permissions {
  private readonly waiting = new Map<number | string, AbortController>()
  private readonly context: PermissionContext
  /** Set by a cancel until the next turn: a request arriving after it is answered cancelled. */
  private cancelled = false

  constructor(context: PermissionContext) {
    this.context = context
  }

  take(id: number | string, params: unknown): void {
    const { rpc, decide } = this.context
    const parsed = request.safeParse(params)
    const call = parsed.success ? askedCall(parsed.data.toolCall) : null
    if (!parsed.success || call === null || this.cancelled) {
      rpc.answer(id, CANCELLED)
      return
    }
    const fixed = undecided(call, this.context.relayed)
    if (fixed !== null) {
      if (!fixed) {
        this.context.refused(call.callId)
      }
      rpc.answer(id, replyOf(parsed.data.options, fixed))
      return
    }
    const control = new AbortController()
    this.waiting.set(id, control)
    const answer = (allow: boolean) => {
      if (this.waiting.get(id) !== control) {
        return
      }
      this.waiting.delete(id)
      if (!allow) {
        this.context.refused(call.callId)
      }
      rpc.answer(id, replyOf(parsed.data.options, allow))
    }
    decide(call, control.signal).then(
      (verdict) => {
        answer(verdict.allow && !control.signal.aborted)
      },
      () => {
        answer(false)
      },
    )
  }

  /** After a cancel: answers each waiting request, and any before the next turn, cancelled. */
  cancel(): void {
    this.cancelled = true
    this.dropAll()
  }

  /** A new turn decides its requests again. */
  resume(): void {
    this.cancelled = false
  }

  /** Answers every request still waiting as cancelled, as ACP asks after a cancel. */
  dropAll(): void {
    for (const [id, control] of [...this.waiting]) {
      this.waiting.delete(id)
      control.abort()
      this.context.rpc.answer(id, CANCELLED)
    }
  }
}
