import type { SessionMessage as ChainEntry } from '@anthropic-ai/claude-agent-sdk'
import type { RewindTarget, TaskRewind } from '@seti/shared'
import type { InputReport, RewindRequest, SessionMessage, SessionReport } from './runtimes/adapter.js'
import type { DefaultSession } from './runtimes/registry.js'
import type { PendingRewind, RewindRow } from './store/rewinds.js'

/** Records how the runtime took a rewind point: applied, or refused with its reason. */
type SettleRewind = (id: number, state: 'applied' | 'refused', reason: string | null) => Promise<void>

/** A session's reports past how it took a rewind point, which the session follows. */
type Followed = SessionMessage | InputReport

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
function promptEntryText(entry: ChainEntry): string | null {
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
export function matchChain(chain: readonly ChainEntry[], point: Pick<RewindPoint, 'keep' | 'text'>): ChainMatch {
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

/** A session's reports, with `applied` called once it applied its rewind; a refusal ends them. */
async function* settled(
  session: AsyncIterable<SessionReport>,
  applied: () => Promise<void>,
): AsyncGenerator<Followed, string | null> {
  for await (const report of session) {
    if (report.type !== 'rewind') {
      yield report
    } else if (report.state === 'refused') {
      return report.reason
    } else {
      await applied()
    }
  }
  return null
}

/**
 * Runs a task's session from the pending rewind point; a refused rewind resumes plainly unless
 * the session was stopped. `open` starts one session each time it is called.
 */
export async function* resumeSession(
  pending: PendingRewind | null,
  settle: SettleRewind,
  open: (rewind: RewindRequest | null) => Promise<DefaultSession>,
  stopped: () => boolean,
): AsyncGenerator<Followed, void> {
  if (pending === null) {
    yield* settled((await open(null)).events, async () => Promise.resolve())
    return
  }
  const rewound = await open({ keep: pending.resume_at, dropsTurn: pending.drops_turn })
  const refused = yield* settled(rewound.events, async () => settle(pending.id, 'applied', null))
  if (refused === null) {
    return
  }
  rewound.close()
  await settle(pending.id, 'refused', refused)
  if (!stopped()) {
    yield* settled((await open(null)).events, async () => Promise.resolve())
  }
}
