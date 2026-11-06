import type { MessageRow } from '@seti/shared'

/** How a turn was cut short: by the user's next message, or by a stop with nothing after it. */
export type Interruption = 'replaced' | 'stopped'

const INTERRUPT_MARKER = '[Request interrupted by user'

type PromptRow = Extract<MessageRow, { kind: 'prompt' }>

const userText = (row: MessageRow): string => {
  if (row.kind !== 'sdk' || row.payload.type !== 'user') {
    return ''
  }
  const { content } = row.payload.message
  return typeof content === 'string'
    ? content
    : content.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

/** A row of a turn the task agent runs: its own reply or a result. */
const turnRow = (row: MessageRow) =>
  row.kind === 'sdk' &&
  (row.payload.type === 'result' || (row.payload.type === 'assistant' && row.payload.parent_tool_use_id === null))

interface TurnScan {
  /** The last result, until a prompt follows it. */
  lastResult: number | null
  /** A message queued during the turn that still waits, or that the agent took. */
  queued: 'waiting' | 'delivered' | null
  marked: boolean
  /** A stopped turn whose taken message may have started the next turn instead of joining it. */
  open: number | null
}

const START: TurnScan = { lastResult: null, queued: null, marked: false, open: null }

function strongest(scan: TurnScan, row: PromptRow): TurnScan['queued'] {
  const { queued } = row.payload
  if (scan.queued === 'waiting' || queued === 'waiting') {
    return 'waiting'
  }
  return scan.queued ?? (queued === 'delivered' ? 'delivered' : null)
}

function scanPrompt(scan: TurnScan, row: PromptRow, out: Map<number, Interruption>): TurnScan {
  if (scan.open !== null) {
    out.set(scan.open, 'stopped')
  }
  if (row.payload.interrupted === true && scan.lastResult !== null) {
    out.set(scan.lastResult, 'replaced')
  }
  return { ...scan, lastResult: null, queued: strongest(scan, row), open: null }
}

/**
 * A stopped turn hands over to a message queued during it that still waits, which goes next.
 * One the agent took may have joined the turn before the stop; it took over only if a turn
 * without its own prompt follows, so whether that holds stays open until the next row.
 */
function scanResult(scan: TurnScan, id: number, out: Map<number, Interruption>): TurnScan {
  if (!scan.marked) {
    return { ...START, lastResult: id }
  }
  if (scan.queued === 'delivered') {
    return { ...START, lastResult: id, open: id }
  }
  out.set(id, scan.queued === 'waiting' ? 'replaced' : 'stopped')
  return { ...START, lastResult: id }
}

/**
 * Result rows of interrupted turns, so they do not read as failures. A turn cut short for the
 * user's next message, an interrupting one or one queued during it, is replaced: that message
 * shows instead. `running` settles a turn whose queued message may have started the next one.
 */
export function interruptedResultIds(rows: readonly MessageRow[], running: boolean): Map<number, Interruption> {
  const interrupted = new Map<number, Interruption>()
  let scan = START
  for (const row of rows) {
    if (scan.open !== null && turnRow(row)) {
      interrupted.set(scan.open, 'replaced')
      scan = { ...scan, open: null }
    }
    if (row.kind === 'prompt') {
      scan = scanPrompt(scan, row, interrupted)
    } else if (row.kind === 'sdk' && row.payload.type === 'result') {
      scan = scanResult(scan, row.id, interrupted)
    } else if (userText(row).startsWith(INTERRUPT_MARKER)) {
      scan = { ...scan, marked: true }
    }
  }
  if (scan.open !== null) {
    interrupted.set(scan.open, running ? 'replaced' : 'stopped')
  }
  return interrupted
}
