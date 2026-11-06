import type {
  AgentActivity,
  AgentActivityEntry,
  AgentActivityQuery,
  DigestLine,
  MessageRow,
  Task,
  TranscriptWindow,
  TranscriptWindowQuery,
} from '@seti/shared'
import { archivedPage } from './archive.js'
import { digestByRow } from './digest.js'
import { hideDirect } from './direct-privacy.js'
import { resolveWindow } from './history-window.js'
import { openQuerySince } from './runner.js'
import { scrubSummary } from './scrub.js'
import { activity, type StoredWindow } from './store/activity.js'
import { workspaceRows } from './store/workspaces.js'
import { subtaskBriefs } from './subtask-cache.js'
import { localDateTime } from './when.js'

/** Rows read per page, and pages per call, so one call stays quick on any agent. */
const PAGE_ROWS = 400
const MAX_PAGES = 15
/** The lines of one call stay under this, whatever `limit` asks, so the reply fits a tool result. */
const LINE_BUDGET = 24_000
const REPLY_CHARS = 280
const TALK_KINDS = new Set(['user', 'agent'])

interface WindowPage {
  /** Rows in the window, newest first. */
  rows: MessageRow[]
  /** The id to read on from, older; null when the window has no older rows. */
  next: number | null
}

const isTalk = (row: MessageRow) => row.kind === 'prompt' || (row.kind === 'sdk' && row.payload.type === 'assistant')

const inWindow = (row: MessageRow, window: StoredWindow) =>
  (window.from === null || row.created_at >= window.from) && (window.to === null || row.created_at < window.to)

/** A page of an archived transcript's window, read chunk by chunk from its archive. */
async function archivedWindowPage(taskId: string, window: StoredWindow, before: number, talkOnly: boolean) {
  const { messages, has_older: older } = await archivedPage(taskId, PAGE_ROWS, before)
  const rows = messages.filter((row) => inWindow(row, window) && (!talkOnly || isTalk(row))).toReversed()
  const oldest = messages[0]
  const done = !older || oldest === undefined || (window.from !== null && oldest.created_at < window.from)
  return { rows, next: done ? null : oldest.id }
}

async function windowPage(task: Task, window: StoredWindow, before: number, talkOnly: boolean): Promise<WindowPage> {
  if (task.archived_at !== null) {
    return archivedWindowPage(task.id, window, before, talkOnly)
  }
  const rows = await activity.rows(task.id, window, { before, talkOnly, limit: PAGE_ROWS })
  return { rows, next: rows.length < PAGE_ROWS ? null : (rows.at(-1)?.id ?? null) }
}

type RowLines = { id: number; lines: DigestLine[] }[]

const shownLines = (digest: RowLines, talkOnly: boolean): RowLines =>
  digest.map(({ id, lines }) => ({ id, lines: lines.filter((line) => !talkOnly || TALK_KINDS.has(line.kind)) }))

/** The newest rows' lines up to `limit` lines and the budget, and the id the rest start before. */
function newest(digest: RowLines, limit: number, render: (line: DigestLine) => string) {
  const picked: string[][] = []
  let count = 0
  let chars = 0
  let oldestId: number | null = null
  for (const { id, lines } of digest.toReversed()) {
    if (lines.length === 0) {
      continue
    }
    const texts = lines.map(render)
    const size = texts.reduce((sum, text) => sum + text.length, 0)
    if (count >= limit || (count > 0 && chars + size > LINE_BUDGET)) {
      return { lines: picked.toReversed().flat(), cursor: oldestId }
    }
    picked.push(texts)
    count += texts.length
    chars += size
    oldestId = id
  }
  return { lines: picked.toReversed().flat(), cursor: null }
}

/** One agent's condensed transcript in a window: newest lines first picked, shown oldest first. */
export async function readTranscript(task: Task, query: TranscriptWindowQuery): Promise<TranscriptWindow> {
  const { stored, view, zone } = await resolveWindow(query)
  const talkOnly = !query.include_tools
  const subtasks = talkOnly ? [] : await subtaskBriefs(task.id, openQuerySince(task.id))
  const rows: MessageRow[] = []
  let next: number | null = query.cursor ?? Number.MAX_SAFE_INTEGER
  let digest: RowLines = []
  for (let pages = 0; next !== null && pages < MAX_PAGES; pages++) {
    const page = await windowPage(task, stored, next, talkOnly)
    rows.push(...(await hideDirect(task.id, page.rows)))
    next = page.next
    digest = shownLines(digestByRow(rows.toReversed(), subtasks), talkOnly)
    if (digest.reduce((sum, row) => sum + row.lines.length, 0) >= query.limit) {
      break
    }
  }
  const render = (line: DigestLine) => `${localDateTime(new Date(line.at), zone)} ${line.kind}: ${line.text}`
  const picked = newest(digest, query.limit, render)
  return {
    task: { id: task.id, title: task.title, archived: task.archived_at !== null },
    window: view,
    lines: picked.lines,
    older_cursor: picked.cursor ?? next,
  }
}

const turns = (entry: AgentActivityEntry) => entry.prompts + entry.update_turns + entry.replies

/** Every agent with turns in a window, most active first, for a skim of what happened. */
export async function agentActivity(query: AgentActivityQuery): Promise<AgentActivity> {
  const { stored, view, zone } = await resolveWindow(query, 'today')
  const [active, prs, archived, spaces] = await Promise.all([
    activity.active(stored),
    activity.linkedPrs(stored),
    activity.archivedSince(stored.from),
    workspaceRows.list(),
  ])
  const names = new Map(spaces.map((space) => [space.id, space.name]))
  const entries = active.map((row): AgentActivityEntry => ({
    id: row.task_id,
    title: row.title,
    workspace: names.get(row.workspace_id) ?? null,
    status: row.status,
    prompts: row.prompts,
    update_turns: row.update_turns,
    replies: row.replies,
    first_at: localDateTime(new Date(row.first_at), zone),
    last_at: localDateTime(new Date(row.last_at), zone),
    prs_linked: prs.filter((pr) => pr.task_id === row.task_id).map((pr) => pr.pr_url),
    last_reply: row.last_reply === null ? null : scrubSummary(row.last_reply, REPLY_CHARS),
  }))
  const sorted = entries.toSorted((a, b) =>
    turns(a) === turns(b) ? b.last_at.localeCompare(a.last_at) : turns(b) - turns(a),
  )
  return {
    window: view,
    agents: sorted.slice(0, query.limit),
    more: Math.max(0, sorted.length - query.limit),
    archived_since: archived,
  }
}
