import { rowEvents, type RuntimeEvent, type SourceKind, type ToolCall, type WireRow } from '@seti/shared'
import { messages } from '../db.js'
import { sourceItems } from '../store/sources.js'
import { githubRead } from './github.js'
import type { FoundItem, ParseResult } from './item.js'
import { isLinearCall, linearKeyIn, linearRead } from './linear.js'
import { isSlackCall, slackHostIn, slackRead } from './slack.js'

/** A source whose answers state the workspace its permalinks are built on. */
type Workspace = Extract<SourceKind, 'slack' | 'linear'>

/** A call whose result the ledger reads: its items, or only the workspace its answer states. */
interface Watched {
  parse: ParseResult | null
  workspace: Workspace | null
}

interface Ended extends Watched {
  callId: string
  text: string
}

const ADAPTERS: readonly ((call: ToolCall) => ParseResult | null)[] = [slackRead, linearRead, githubRead]

/** Calls each task's agent started whose result the ledger will read, by call id. */
const started = new Map<string, Map<string, Watched>>()
/** The workspace each task's answers from a source stated last, by `<kind>:<task>`. */
const workspaces = new Map<string, string>()

/** How each source's answers state its workspace, and how its permalinks name it. */
const WORKSPACES: Record<Workspace, { statedIn: (text: string) => string | null; of: (permalink: string) => string }> =
  {
    slack: { statedIn: slackHostIn, of: (permalink) => new URL(permalink).hostname },
    linear: { statedIn: linearKeyIn, of: (permalink) => new URL(permalink).pathname.split('/')[1] ?? '' },
  }

const workspaceOf = (call: ToolCall): Workspace | null => {
  if (isSlackCall(call)) {
    return 'slack'
  }
  return isLinearCall(call) ? 'linear' : null
}

/** Calls a task may have open at once before the oldest are dropped. */
const OPEN_MAX = 200

function watchedOf(call: ToolCall): Watched | null {
  const parse = ADAPTERS.reduce<ParseResult | null>((first, adapter) => first ?? adapter(call), null)
  const workspace = workspaceOf(call)
  return parse === null && workspace === null ? null : { parse, workspace }
}

function step(calls: Map<string, Watched>, event: RuntimeEvent): Ended[] {
  if (event.type === 'tool.started') {
    const watched = watchedOf(event.call)
    if (watched !== null) {
      calls.set(event.call.callId, watched)
      const oldest = calls.size > OPEN_MAX ? calls.keys().next().value : undefined
      if (oldest !== undefined) {
        calls.delete(oldest)
      }
    }
    return []
  }
  const watched = event.type === 'tool.ended' ? calls.get(event.callId) : undefined
  if (event.type !== 'tool.ended' || watched === undefined) {
    return []
  }
  calls.delete(event.callId)
  return event.status === 'ok' ? [{ ...watched, callId: event.callId, text: event.result.text }] : []
}

function ended(taskId: string, events: readonly RuntimeEvent[]): Ended[] {
  const calls = started.get(taskId) ?? new Map<string, Watched>()
  const done = events.flatMap((event) => step(calls, event))
  if (calls.size === 0) {
    started.delete(taskId)
  } else {
    started.set(taskId, calls)
  }
  return done
}

const SAFE_ITEMS: FoundItem[] = []

/** The items a reader finds; a reader that throws finds none, and nothing of the text is logged. */
function itemsOf(parse: ParseResult, text: string, workspace: string | null): FoundItem[] {
  try {
    return parse(text, workspace)
  } catch {
    return SAFE_ITEMS
  }
}

/** The workspace a task's answers from a source stated, else the one its newest permalink names. */
async function workspaceFor(taskId: string, kind: Workspace): Promise<string | null> {
  const known = workspaces.get(`${kind}:${taskId}`)
  if (known !== undefined) {
    return known
  }
  const permalink = await sourceItems.newestPermalink(taskId, kind)
  return permalink === null ? null : WORKSPACES[kind].of(permalink)
}

async function keep(taskId: string, messageId: number, call: Ended): Promise<void> {
  const kind = call.workspace
  const stated = kind === null ? null : WORKSPACES[kind].statedIn(call.text)
  if (kind !== null && stated !== null) {
    workspaces.set(`${kind}:${taskId}`, stated)
  }
  if (call.parse === null) {
    return
  }
  const workspace = kind === null ? null : await workspaceFor(taskId, kind)
  const items = itemsOf(call.parse, call.text, workspace)
  const linked = items.find((item) => item.kind === kind && item.permalink !== '')
  if (kind !== null && linked !== undefined && workspace === null) {
    workspaces.set(`${kind}:${taskId}`, WORKSPACES[kind].of(linked.permalink))
  }
  await sourceItems.add(taskId, messageId, call.callId, items)
}

/**
 * Records the source items in the tool results of one stored transcript row, read from the row as
 * stored, so the ledger sees the same redacted text as the transcript.
 */
export async function recordSources(taskId: string, row: WireRow): Promise<void> {
  try {
    for (const call of ended(taskId, rowEvents(row))) {
      await keep(taskId, row.id, call)
    }
  } catch (e) {
    const reason = e instanceof Error ? e.name : 'unknown'
    const entry = { level: 'warn', msg: 'evidence ledger skipped a row', task_id: taskId, message_id: row.id, reason }
    process.stderr.write(`${JSON.stringify(entry)}\n`)
  }
}

const PAGE = 500

/** Reads the agent's ledger again from its whole transcript, as after a restore. */
export async function rebuildSources(taskId: string): Promise<void> {
  await sourceItems.clear(taskId)
  started.delete(taskId)
  workspaces.delete(`slack:${taskId}`)
  workspaces.delete(`linear:${taskId}`)
  let after = 0
  for (;;) {
    const rows = await messages.firstAfter(taskId, after, PAGE)
    for (const row of rows) {
      await recordSources(taskId, row)
    }
    const last = rows.at(-1)
    if (last === undefined) {
      break
    }
    after = last.id
  }
  started.delete(taskId)
}
