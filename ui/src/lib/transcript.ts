import {
  SHELL_CONTEXT_RUNS,
  eventsOf,
  heldForMessage,
  isRuntimeRow,
  quietReason,
  rowEvents,
  type EventOf,
  type WireRow,
  type RuntimeEvent,
  type ToolCall,
  type ToolResult,
} from '@seti/shared'

/** A tool call as the transcript shows it. */
export type ToolUseBlock = ToolCall

/** A tool result and the stored message it came from, which holds it in full. */
export interface ToolResultRef {
  callId: string
  failed: boolean
  /** The call was stopped before it finished, as an interrupt does; set only then. */
  stopped?: true
  result: ToolResult
  rowId: number
  /** When the result arrived, which ends the call's duration. */
  at: string
  trimmed: boolean
}

/** Where a background process a call started stands, as the session last reported it. */
export type BackgroundStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'killed'

export interface TranscriptIndex {
  results: ReadonlyMap<string, ToolResultRef>
  calls: ReadonlySet<string>
  hiddenInits: ReadonlySet<number>
  /** Background processes by the call that started them, such as a Monitor's watch. */
  background: ReadonlyMap<string, BackgroundStatus>
}

/** A string field of a tool input, if present. */
export function inputString(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined
  }
  const value = (input as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

const NO_RESULTS: readonly ToolResultRef[] = []
const NO_CALLS: readonly ToolUseBlock[] = []
const resultCache = new WeakMap<WireRow, readonly ToolResultRef[]>()
const callCache = new WeakMap<WireRow, readonly ToolUseBlock[]>()

/** Tool results in a row, cached per row object so memoized rows get stable references. */
export function rowResults(row: WireRow): readonly ToolResultRef[] {
  const cached = resultCache.get(row)
  if (cached) {
    return cached
  }
  const trimmed = new Set(row.trimmed)
  const ends = eventsOf(rowEvents(row), 'tool.ended')
  const refs =
    ends.length === 0
      ? NO_RESULTS
      : ends.map((end) => ({
          callId: end.callId,
          failed: end.status !== 'ok' && end.status !== 'cancelled',
          ...(end.status === 'cancelled' ? { stopped: true as const } : {}),
          result: end.result,
          rowId: row.id,
          at: row.created_at,
          trimmed: trimmed.has(end.callId),
        }))
  resultCache.set(row, refs)
  return refs
}

/** Tool calls in a row, cached per row object so memoized rows get stable references. */
export function rowCalls(row: WireRow): readonly ToolUseBlock[] {
  const cached = callCache.get(row)
  if (cached) {
    return cached
  }
  const starts = eventsOf(rowEvents(row), 'tool.started')
  const calls = starts.length === 0 ? NO_CALLS : starts.map((start) => start.call)
  callCache.set(row, calls)
  return calls
}

const PATCH_STATUS: Partial<Record<string, BackgroundStatus>> = {
  pending: 'running',
  paused: 'running',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
}

/** Follows each job's start, updates and end to the latest status of the call that started it. */
function trackBackground(event: RuntimeEvent, owners: Map<string, string>, background: Map<string, BackgroundStatus>) {
  if (event.type === 'job.started' && event.callId !== null) {
    owners.set(event.jobId, event.callId)
    background.set(event.callId, 'running')
  } else if (event.type === 'job.ended' && event.callId !== null) {
    background.set(event.callId, event.status)
  } else if (event.type === 'job.updated') {
    const owner = owners.get(event.jobId)
    const status = PATCH_STATUS[event.status ?? '']
    if (owner !== undefined && status !== undefined) {
      background.set(owner, status)
    }
  }
}

export function indexTranscript(rows: readonly WireRow[]): TranscriptIndex {
  const results = new Map<string, ToolResultRef>()
  const calls = new Set<string>()
  const hiddenInits = new Set<number>()
  const owners = new Map<string, string>()
  const background = new Map<string, BackgroundStatus>()
  let session: string | null = null
  for (const row of rows) {
    for (const event of rowEvents(row)) {
      trackBackground(event, owners, background)
      if (event.type === 'session.started') {
        if (event.sessionId === session) {
          hiddenInits.add(row.id)
        }
        session = event.sessionId
      }
    }
    for (const ref of rowResults(row)) {
      results.set(ref.callId, ref)
    }
    for (const call of rowCalls(row)) {
      calls.add(call.callId)
    }
  }
  return { results, calls, hiddenInits, background }
}

/** What a slash command that runs without the model printed, or null for other rows. */
export const localCommandOutput = (row: WireRow): string | null =>
  eventsOf(rowEvents(row), 'message').find((event) => event.role === 'command')?.text ?? null

/** Whether a row shows up in the transcript, so counts of new messages skip bookkeeping rows. */
export function rendersContent(row: WireRow): boolean {
  try {
    return shows(row)
  } catch {
    return true
  }
}

/** A turn the runtime ran for a background notice without a step, as a resumed session does. */
const emptyNoticeTurn = (end: EventOf<'turn.ended'>) =>
  end.cause === 'background' && end.steps === 0 && end.status !== 'error'

/** Whether one runtime event shows: words, a call, a turn's end, a compaction, a model switch. */
function showsEvent(event: RuntimeEvent): boolean {
  if (event.type === 'message') {
    return event.role === 'command' || (event.role === 'agent' && event.text.trim() !== '')
  }
  if (event.type === 'turn.ended') {
    return !emptyNoticeTurn(event)
  }
  if (event.type === 'compaction') {
    return event.phase === 'done' || event.phase === 'failed'
  }
  if (event.type === 'vendor') {
    return event.unreadable === true
  }
  return event.type === 'tool.started' || (event.type === 'model.changed' && event.reason === 'refusal')
}

/** Throws for a runtime row its projector could not read, so the row shows that it failed. */
export function assertReadable(row: WireRow): void {
  const unreadable = eventsOf(rowEvents(row), 'vendor').find((event) => event.unreadable === true)
  if (unreadable !== undefined) {
    throw new Error(`Stored ${unreadable.name} message does not fit its runtime`)
  }
}

function shows(row: WireRow): boolean {
  return !isRuntimeRow(row) || rowEvents(row).some(showsEvent)
}

/** Events of what an agent said, did and was told, which carry the thread of the agent. */
const THREADED: ReadonlySet<RuntimeEvent['type']> = new Set([
  'message',
  'reasoning',
  'tool.started',
  'tool.ended',
  'notice',
])

/** The subagent thread a row's runtime messages belong to, or null for the task agent's own. */
export function subagentOf(row: WireRow): string | null {
  const thread = rowEvents(row).find((event) => THREADED.has(event.type))?.thread
  return thread === undefined || thread === '' ? null : thread
}

/** The Agent call of the subagent a PR update was routed to on behalf of, if any. */
export const routedSubagentOf = (row: WireRow): string | null =>
  row.kind === 'input' && row.payload.source === 'pr' ? (row.payload.subtask?.tool_use_id ?? null) : null

/** New rows shown since `afterId`; subagent rows count only in a subtask's own transcript. */
export function countNewer(rows: readonly WireRow[], afterId: number, subagentRows: boolean): number {
  let count = 0
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]
    if (row === undefined || row.id <= afterId) {
      break
    }
    if (rendersContent(row) && (subagentRows || subagentOf(row) === null)) {
      count++
    }
  }
  return count
}

/** Merges rows by ascending id, keeping existing row objects, and `rows` itself when unchanged. */
export function mergeRows(rows: readonly WireRow[], incoming: readonly WireRow[]): readonly WireRow[] {
  const first = rows[0]
  const last = rows.at(-1)
  const incomingFirst = incoming[0]
  const incomingLast = incoming.at(-1)
  if (incomingFirst === undefined || incomingLast === undefined) {
    return rows
  }
  if (first === undefined || last === undefined) {
    return incoming
  }
  if (incomingFirst.id > last.id) {
    return [...rows, ...incoming]
  }
  if (incomingLast.id < first.id) {
    return [...incoming, ...rows]
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const added = incoming.filter((row) => !byId.has(row.id))
  if (added.length === 0) {
    return rows
  }
  return [...rows, ...added].sort((a, b) => a.id - b.id)
}

/** Swaps in a newer copy of a loaded row; rows that are not loaded stay out. */
export function replaceRow(rows: readonly WireRow[], row: WireRow): readonly WireRow[] {
  const index = rows.findIndex((loaded) => loaded.id === row.id)
  return index < 0 ? rows : rows.with(index, row)
}

/** A result's text as the transcript shows it, with a marker for each part that is not text. */
export const resultText = (ref: Pick<ToolResultRef, 'result'> | undefined): string =>
  ref === undefined ? '' : (ref.result.shown ?? ref.result.text)

export const fullResultText = (row: WireRow, toolUseId: string) =>
  resultText(rowResults(row).find((ref) => ref.callId === toolUseId))

export const fullInputText = (row: WireRow, toolUseId: string) =>
  JSON.stringify(rowCalls(row).find((call) => call.callId === toolUseId)?.input, null, 2)

export const fullCommandText = (row: WireRow, toolUseId: string) =>
  inputString(rowCalls(row).find((call) => call.callId === toolUseId)?.input, 'command') ?? ''

/** A prompt the agent reads with what waited for it: not a slash command, not taken back. */
const readsPending = (row: WireRow) =>
  row.kind === 'prompt' && !row.payload.text.startsWith('/') && row.payload.queued !== 'removed'

/** Whether the prompt also took the updates held for the user's next message. */
const takesHeld = (row: WireRow) => row.kind === 'prompt' && (row.payload.auto !== true || row.payload.held === true)

/**
 * Updates waiting for the agent: undismissed, not quiet input rows after the last prompt it read.
 * Updates held for the user's next message outlast the turns Seti starts by itself.
 */
export function queuedInputs(rows: readonly WireRow[]): Extract<WireRow, { kind: 'input' }>[] {
  let queued: Extract<WireRow, { kind: 'input' }>[] = []
  for (const row of rows) {
    if (readsPending(row)) {
      queued = takesHeld(row) ? [] : queued.filter((input) => heldForMessage(input.payload))
    } else if (
      row.kind === 'input' &&
      row.payload.dismissed_at === undefined &&
      quietReason(row.payload) === undefined
    ) {
      queued.push(row)
    }
  }
  return queued
}

export const queuedInputIds = (rows: readonly WireRow[]): Set<number> =>
  new Set(queuedInputs(rows).map((row) => row.id))

/** Whether a `!` run goes with the next message, or waits past the newest few that do. */
export type ShellDelivery = 'next' | 'dropped'

/** Shell runs since the last prompt the agent read, as `shellRuns.sinceLastTurn` picks them. */
export function shellDeliveries(rows: readonly WireRow[]): Map<number, ShellDelivery> {
  let pending: number[] = []
  for (const row of rows) {
    if (readsPending(row)) {
      pending = []
    } else if (row.kind === 'shell') {
      pending.push(row.id)
    }
  }
  const sent = pending.length - SHELL_CONTEXT_RUNS
  return new Map(pending.map((id, index) => [id, index < sent ? 'dropped' : 'next']))
}

/** The texts the task agent wrote since its last tool call, with this event applied. */
function replyTail(event: RuntimeEvent, tail: readonly string[]): readonly string[] {
  if (event.thread !== '') {
    return tail
  }
  if (event.type === 'tool.started') {
    return []
  }
  return event.type === 'message' && event.role === 'agent' && event.text.trim() !== '' ? [...tail, event.text] : tail
}

/** Each turn's reply by its result row: the Markdown of its texts after the last tool call. */
export function turnReplies(rows: readonly WireRow[]): Map<number, string> {
  const replies = new Map<number, string>()
  let tail: readonly string[] = []
  for (const row of rows) {
    if (row.kind === 'prompt') {
      tail = []
      continue
    }
    for (const event of rowEvents(row)) {
      if (event.type === 'turn.ended') {
        if (tail.length > 0) {
          replies.set(row.id, tail.join('\n\n'))
        }
        tail = []
      } else {
        tail = replyTail(event, tail)
      }
    }
  }
  return replies
}
