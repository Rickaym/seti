import type { Options, Query, SDKMessage, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RewindTarget, TaskRewind } from '@seti/shared'
import { rewinds, type PendingRewind, type RewindRow } from './store/rewinds.js'

/** Error texts of a truncated resume that Claude Code will refuse again, so it is never retried. */
const REFUSALS = ['Resume rejected by --resume-drops-turn:', 'No message found with message.uuid of:']

/** A prompt the task can go back to, and the last chain entry of the conversation to keep. */
export interface RewindPoint extends RewindTarget {
  /** Uuid of the kept conversation's last chain entry; null when nothing before it is kept. */
  keep: string | null
  last_message_id: number
}

const isChainRow = (row: RewindRow) =>
  row.kind === 'sdk' && (row.type === 'assistant' || row.type === 'user') && row.uuid !== null && row.sidechain === 0

const countsAsMessage = (row: RewindRow) => row.kind !== 'sdk' || isChainRow(row)

function rewoundBy(history: readonly TaskRewind[]): (row: RewindRow) => boolean {
  const ranges = history.filter((r) => r.restore !== 'code' && r.state !== 'refused')
  return (row) => ranges.some((r) => row.id >= r.prompt_message_id && row.id <= r.last_message_id)
}

/**
 * Prompts a conversation rewind can return to, oldest first. Slash commands and prompts sent
 * during a turn are skipped, since Claude Code's chain has no clean point just before them.
 */
export function rewindPoints(rows: readonly RewindRow[], history: readonly TaskRewind[], sessionId: string | null) {
  const rewound = rewoundBy(history)
  const live = rows.filter((row) => !rewound(row))
  const lastId = rows.at(-1)?.id ?? 0
  const points: RewindPoint[] = []
  let kept: RewindRow | null = null
  let remaining = live.filter(countsAsMessage).length
  for (const row of live) {
    const text = row.kind === 'prompt' && row.queued === null ? (row.text ?? '') : null
    const keepable = kept === null || kept.session_id === sessionId
    if (text !== null && !text.trimStart().startsWith('/') && keepable) {
      points.push({
        message_id: row.id,
        text,
        created_at: row.created_at,
        message_count: remaining,
        keep: kept?.uuid ?? null,
        last_message_id: lastId,
      })
    }
    if (countsAsMessage(row)) {
      remaining--
    }
    if (isChainRow(row)) {
      kept = row
    }
  }
  return points
}

const blockText = (block: unknown): string =>
  typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : ''

function isToolResult(block: unknown): boolean {
  return typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result'
}

/** The typed text of a user chain entry, or null for tool results and other entries. */
function promptEntryText(entry: SessionMessage): string | null {
  const { message } = entry
  if (entry.type !== 'user' || typeof message !== 'object' || message === null || !('content' in message)) {
    return null
  }
  const { content } = message
  if (typeof content === 'string') {
    return content
  }
  if (!Array.isArray(content) || content.length === 0 || content.some(isToolResult)) {
    return null
  }
  return content.map(blockText).join('\n')
}

/** Where a rewind point sits in the session file Claude Code keeps. */
export interface ChainMatch {
  /** False when the session history is readable and the kept entry is not in it. */
  keep_found: boolean
  /** Uuid of the chosen prompt's own entry, which file checkpoints are keyed by. */
  prompt_uuid: string | null
  /** The same uuid when the rewind drops exactly that one turn, for Claude Code to check. */
  drops_turn: string | null
}

/** Finds the chosen prompt in the session chain, right after the kept entry. */
export function matchChain(chain: readonly SessionMessage[], point: Pick<RewindPoint, 'keep' | 'text'>): ChainMatch {
  const start = point.keep === null ? 0 : chain.findIndex((entry) => entry.uuid === point.keep) + 1
  if (chain.length > 0 && point.keep !== null && start === 0) {
    return { keep_found: false, prompt_uuid: null, drops_turn: null }
  }
  const prompts = chain.slice(start).flatMap((entry) => {
    const text = promptEntryText(entry)
    return text === null ? [] : [{ uuid: entry.uuid, text }]
  })
  const wanted = point.text.trim()
  const own = prompts.find((entry) => entry.text.includes(wanted))
  const only = prompts.length === 1 && own !== undefined && point.keep !== null
  return { keep_found: true, prompt_uuid: own?.uuid ?? null, drops_turn: only ? own.uuid : null }
}

/** The resume options for a pending rewind; a rewind to the first prompt starts a new session. */
function rewoundOptions(options: Options, pending: PendingRewind): Options {
  const { resume, ...rest } = options
  if (pending.resume_at === null || resume === undefined) {
    return rest
  }
  const drops = pending.drops_turn === null ? {} : { resumeDropsTurn: pending.drops_turn }
  return { ...rest, resume, resumeSessionAt: pending.resume_at, ...drops }
}

const resultErrors = (m: SDKMessage) => (m.type === 'result' && m.subtype !== 'success' ? m.errors : [])

/** The refusal text when a message says Claude Code declined the truncated resume, else null. */
export function refusalOf(m: SDKMessage | Error): string | null {
  const texts = m instanceof Error ? [m.message] : resultErrors(m)
  for (const text of texts) {
    const at = Math.max(...REFUSALS.map((prefix) => text.indexOf(prefix)))
    if (at >= 0) {
      return text.slice(at)
    }
  }
  return null
}

/** Follows a session opened at a rewind point until Claude Code accepts or refuses it. */
async function* rewoundSession(
  session: AsyncIterable<SDKMessage>,
  rewindId: number,
): AsyncGenerator<SDKMessage, string | null> {
  let applied = false
  try {
    for await (const m of session) {
      const refused = applied ? null : refusalOf(m)
      if (refused !== null) {
        return refused
      }
      if (!applied && m.type === 'system' && m.subtype === 'init') {
        await rewinds.settle(rewindId, 'applied')
        applied = true
      }
      yield m
    }
  } catch (e) {
    const refused = !applied && e instanceof Error ? refusalOf(e) : null
    if (refused === null) {
      throw e
    }
    return refused
  }
  return null
}

/**
 * Runs a task's session like `query`, from the pending rewind point; a refused rewind resumes
 * plainly. `open` starts one query with the given options each time it is called.
 */
export async function* resumeSession(
  taskId: string,
  options: Options,
  open: (options: Options) => Query,
): AsyncGenerator<SDKMessage, void> {
  const pending = await rewinds.pending(taskId)
  if (pending === undefined) {
    yield* open(options)
    return
  }
  const rewound = open(rewoundOptions(options, pending))
  const refused = yield* rewoundSession(rewound, pending.id)
  if (refused === null) {
    return
  }
  rewound.close()
  await rewinds.settle(pending.id, 'refused', refused)
  if (options.abortController?.signal.aborted !== true) {
    yield* open(options)
  }
}
