import type { ToolCall } from '@seti/shared'
import { askedOf, type CodexDecide } from './approvals.js'
import { codexReport, type ReportQueue } from './reports.js'
import type { CodexCall, CodexRpc } from './rpc.js'

type Request = CodexCall & { id: number | string }

/** An ask Seti still owes Codex an answer to. */
interface Waiting {
  control: AbortController
  /** Records that the ask ended without Seti's answer. */
  dropped: () => void
}

/** What answering Codex's asks needs from the session it belongs to. */
export interface AskContext {
  rpc: CodexRpc
  reports: ReportQueue
  decide: CodexDecide
  /** The agent's own thread, once Codex named it. */
  root: () => string
  /** The call an item Codex started stands for, by the item's id. */
  started: (itemId: string) => ToolCall | undefined
}

/**
 * Codex's asks of one session: each goes to Seti's decision, which may take as long as the user
 * takes; an ask Codex no longer waits for aborts its decision's signal.
 */
export class Asks {
  private readonly waiting = new Map<number | string, Waiting>()
  private readonly context: AskContext

  constructor(context: AskContext) {
    this.context = context
  }

  take(message: Request): void {
    const { rpc, reports, decide } = this.context
    let asked
    try {
      asked = askedOf(message.method, message.params, this.context.started)
    } catch (e) {
      rpc.refuse(message.id, e instanceof Error ? e.message : String(e))
      return
    }
    if (asked === null) {
      rpc.refuse(message.id, `Seti does not answer ${message.method}`)
      return
    }
    const question = message.method === 'item/tool/requestUserInput'
    const record = (reply?: unknown) => {
      if (question) {
        reports.push(codexReport(this.context.root(), message, { reply }))
      }
    }
    record()
    const control = new AbortController()
    const ask: Waiting = {
      control,
      dropped: () => {
        record(asked.cancelled)
      },
    }
    this.waiting.set(message.id, ask)
    const answer = (reply: unknown) => {
      if (this.waiting.get(message.id) === ask) {
        this.waiting.delete(message.id)
        rpc.answer(message.id, reply)
        record(reply)
      }
    }
    decide(asked.call, control.signal).then(
      (verdict) => {
        answer(control.signal.aborted ? asked.cancelled : asked.reply(verdict))
      },
      (e: unknown) => {
        answer(asked.reply({ allow: false, message: e instanceof Error ? e.message : String(e) }))
      },
    )
  }

  /** Codex no longer waits for this ask, as when it resolved the ask itself. */
  drop(id: number | string | undefined): void {
    const ask = id === undefined ? undefined : this.waiting.get(id)
    if (id === undefined || ask === undefined) {
      return
    }
    this.waiting.delete(id)
    ask.control.abort()
    ask.dropped()
  }

  dropAll(): void {
    for (const id of [...this.waiting.keys()]) {
      this.drop(id)
    }
  }
}
