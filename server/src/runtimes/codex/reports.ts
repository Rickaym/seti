import { projectCodex, type CodexJob, type CodexMessage } from '@seti/shared'
import type { SessionMessage } from '../adapter.js'
import type { RpcCall } from '../json-rpc.js'
import { kept, keptMessage } from './private.js'

/** Methods that report the agent or a subagent at work, rather than news about the session. */
const WORK = /^(?:turn\/|item\/)/

/** What a stored row carries beside Codex's message: taken inputs, an answer, a job, open calls. */
export interface RowExtras {
  delivered?: readonly string[]
  reply?: unknown
  job?: CodexJob
  unfinished?: readonly string[]
}

/** A message Codex sent, as the session reports it: stored with the agent's thread, and projected. */
export function codexReport(root: string, message: RpcCall, extras: RowExtras = {}): SessionMessage {
  const { delivered = [], reply, job, unfinished = [] } = extras
  const raw: CodexMessage = {
    root,
    message: keptMessage(message),
    ...(reply === undefined ? {} : { reply: kept(reply) }),
    ...(job === undefined ? {} : { job }),
    ...(unfinished.length === 0 ? {} : { unfinished }),
  }
  const events = projectCodex(raw)
  const work = WORK.test(message.method)
  return {
    type: 'message',
    raw,
    events,
    work,
    byAgent: work && events.every((event) => event.thread === ''),
    delivered,
  }
}
