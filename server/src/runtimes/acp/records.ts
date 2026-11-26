import { randomUUID } from 'node:crypto'
import { projectAcp, type AcpRecord } from '@seti/shared'
import type { SessionMessage } from '../adapter.js'

/** A record Seti stores for an ACP session, as the session reports it; opening is no work. */
export function acpReport(record: AcpRecord, delivered: readonly string[] = []): SessionMessage {
  const work = record.seti !== 'started'
  return { type: 'message', raw: record, events: projectAcp(record), work, byAgent: work, delivered }
}

/** Updates Seti does not store: the context size after each model call, the agent's commands. */
const DROPPED = new Set(['usage_update', 'available_commands_update', 'current_mode_update'])

const CHUNKS = new Set(['agent_message_chunk', 'agent_thought_chunk'])

const kindOf = (update: unknown): string => {
  const kind = (update as { sessionUpdate?: unknown } | null)?.sessionUpdate
  return typeof kind === 'string' ? kind : ''
}

const textOf = (update: unknown): string | null => {
  const content = (update as { content?: { type?: unknown; text?: unknown } } | null)?.content
  return content?.type === 'text' && typeof content.text === 'string' ? content.text : null
}

/** A run of message or thought chunks, joined into one update. */
interface Run {
  kind: string
  text: string
}

/**
 * Turns an ACP agent's stream of updates into the records Seti stores: consecutive text chunks of
 * one kind become one update, and updates that only report the session's state are dropped.
 */
export class UpdateJoiner {
  private run: Run | null = null
  /** The agent's last message of the current turn, which its end reports as the result. */
  private said = ''

  /** The records this update completes; a chunk is held until something else arrives. */
  take(update: unknown, denied: boolean): AcpRecord[] {
    const kind = kindOf(update)
    if (DROPPED.has(kind)) {
      return []
    }
    const text = textOf(update)
    if (CHUNKS.has(kind) && text !== null) {
      if (this.run?.kind === kind) {
        this.run.text += text
        return []
      }
      const done = this.flush()
      this.run = { kind, text }
      return done
    }
    const record: AcpRecord = { seti: 'update', id: randomUUID(), update, ...(denied ? { denied: true } : {}) }
    return [...this.flush(), record]
  }

  /** The held chunks as one update, if any. */
  flush(): AcpRecord[] {
    const run = this.run
    this.run = null
    if (run === null) {
      return []
    }
    if (run.kind === 'agent_message_chunk') {
      this.said = run.text
    }
    const update = { sessionUpdate: run.kind, content: { type: 'text', text: run.text } }
    return [{ seti: 'update', id: randomUUID(), update }]
  }

  /** The turn's last message, cleared for the next turn. */
  result(): string {
    const text = this.said
    this.said = ''
    return text
  }
}

/**
 * A tool server call's update with the server and tool named as Gemini CLI names them on its
 * permission request, which its call updates leave out: the call id starts with
 * `mcp_<server>_<tool>__`, read against the servers Seti handed the agent, the longest first.
 */
export function namingServer(update: unknown, servers: readonly string[]): unknown {
  if (typeof update !== 'object' || update === null || '_meta' in update || !('toolCallId' in update)) {
    return update
  }
  const id = update.toolCallId
  const name = typeof id === 'string' ? id.slice(0, Math.max(id.indexOf('__'), 0)) : ''
  const server = servers
    .toSorted((a, b) => b.length - a.length)
    .find((each) => name.startsWith(`mcp_${each}_`) && name.length > each.length + 5)
  if (server === undefined) {
    return update
  }
  const mcp = { server_name: server, tool_name: name.slice(server.length + 5) }
  return { ...update, _meta: { 'gemini-cli': { mcp } } }
}
