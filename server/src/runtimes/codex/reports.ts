import { projectCodex, type CodexMessage } from '@seti/shared'
import type { SessionMessage, SessionReport } from '../adapter.js'
import type { CodexCall } from './rpc.js'

/** Reports in the order they were made, read once; it ends, or fails with the session's error. */
export class ReportQueue implements AsyncIterable<SessionReport> {
  private readonly items: SessionReport[] = []
  private wake: (() => void) | null = null
  private over = false
  private error: Error | null = null

  push(report: SessionReport): void {
    if (!this.over) {
      this.items.push(report)
      this.poke()
    }
  }

  end(): void {
    this.over = true
    this.poke()
  }

  fail(error: Error): void {
    if (!this.over) {
      this.error = error
      this.end()
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SessionReport> {
    for (;;) {
      const next = this.items.shift()
      if (next !== undefined) {
        yield next
      } else if (this.error !== null) {
        throw this.error
      } else if (this.over) {
        return
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
      }
    }
  }

  private poke(): void {
    const wake = this.wake
    this.wake = null
    wake?.()
  }
}

/** Methods that report the agent or a subagent at work, rather than news about the session. */
const WORK = /^(?:turn\/|item\/)/

/**
 * A message Codex sent, as the session reports it: stored with the agent's thread, and projected.
 * With `reply`, the row records Seti's answer to that request.
 */
export function codexReport(
  root: string,
  message: CodexCall,
  delivered: readonly string[] = [],
  reply?: unknown,
): SessionMessage {
  const raw: CodexMessage = reply === undefined ? { root, message } : { root, message, reply }
  const events = projectCodex(raw)
  return {
    type: 'message',
    raw,
    events,
    work: WORK.test(message.method),
    byAgent: events.every((event) => event.thread === ''),
    delivered,
  }
}
