import { TASK_STREAM_CURSOR, type MessageRow, type TaskEvent } from '@seti/shared'
import type { Context } from 'hono'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { archivedPage } from '../archive.js'
import { messages, tasks } from '../db.js'
import { openQuerySince, sessionState, subscribe } from '../runner.js'
import { agentTodos, subtaskBriefs } from '../subtask-cache.js'
import { currentSeq, editedSince, STREAM_EPOCH } from '../task-events.js'
import { wirePage, wireRow } from '../transcript.js'

const KEEPALIVE_MS = 15_000
/** New rows a resuming stream sends one by one; a longer gap gets a fresh backlog instead. */
const CATCH_UP = 500

/** Where a stream starts: after a cursor the client sent, or with the newest `tail` messages. */
interface StreamStart {
  after: string | undefined
  tail: number
  /** An archived task streams its archived backlog and then only a restore. */
  archived: boolean
}

/** What the client holds: messages up to `message`, and every event of this run up to `seq`. */
interface Cursor {
  message: number
  seq: number
}

const cursorId = (cursor: Cursor) => `${String(cursor.message)}.${STREAM_EPOCH}.${String(cursor.seq)}`

/** The cursor a client sent, or null when it is a bare message id or from another server run. */
function parseCursor(text: string): Cursor | null {
  const [, message, epoch, seq] = TASK_STREAM_CURSOR.exec(text) ?? []
  if (message === undefined || epoch !== STREAM_EPOCH || seq === undefined) {
    return null
  }
  return { message: Number(message), seq: Number(seq) }
}

type MessageEvent = Extract<TaskEvent, { type: 'message' }>
type OtherEvent = Exclude<TaskEvent, MessageEvent>

/** The data of an event other than a new message, as the stream sends it. */
function dataOf(event: OtherEvent): string {
  switch (event.type) {
    case 'status':
      return JSON.stringify({ status: event.status })
    case 'shell':
      return JSON.stringify(event.progress)
    case 'prs':
    case 'mcp':
      return ''
    case 'subtasks':
      return JSON.stringify(event.subtasks)
    case 'todos':
      return JSON.stringify(event.todos)
    case 'updated':
      return JSON.stringify(wireRow(event.row))
    case 'archived':
      return JSON.stringify({ archived: event.archived })
    case 'session':
      return JSON.stringify(event.session)
    case 'permission':
      return JSON.stringify({ request: event.request, blocked: event.blocked })
    case 'blocked':
      return JSON.stringify({ blocked: event.blocked })
  }
}

/** Writes an event with the cursor as its id, skipping a message the client already holds. */
async function writeEvent(stream: SSEStreamingApi, event: TaskEvent, cursor: Cursor): Promise<Cursor> {
  if (event.type !== 'message') {
    await stream.writeSSE({ event: event.type, id: cursorId(cursor), data: dataOf(event) })
    return cursor
  }
  if (event.row.id <= cursor.message) {
    return cursor
  }
  const next = { ...cursor, message: event.row.id }
  await stream.writeSSE({ event: 'message', id: cursorId(next), data: JSON.stringify(wireRow(event.row)) })
  return next
}

/** Sends the newest messages in one `backlog` event, which replaces the rows the client shows. */
async function writeBacklog(stream: SSEStreamingApi, taskId: string, start: StreamStart, seq: number): Promise<Cursor> {
  const page = start.archived ? await archivedPage(taskId, start.tail) : await messages.page(taskId, start.tail)
  const cursor = { message: page.messages.at(-1)?.id ?? 0, seq }
  await stream.writeSSE({ event: 'backlog', id: cursorId(cursor), data: JSON.stringify(wirePage(page)) })
  return cursor
}

interface CatchUp {
  from: Cursor
  edited: MessageRow[]
  added: MessageRow[]
}

/** The rows edited and added since the client's cursor, or null when a backlog must replace them. */
async function catchUp(taskId: string, start: StreamStart): Promise<CatchUp | null> {
  const from = start.archived || start.after === undefined ? null : parseCursor(start.after)
  const ids = from === null ? null : editedSince(taskId, from.seq)
  if (from === null || ids === null) {
    return null
  }
  const added = await messages.firstAfter(taskId, from.message, CATCH_UP + 1)
  if (added.length > CATCH_UP) {
    return null
  }
  const edited = await messages.byIds(
    taskId,
    ids.filter((id) => id <= from.message),
  )
  return { from, edited, added }
}

export const streamTask = (c: Context, taskId: string, start: StreamStart) =>
  streamSSE(c, async (stream) => {
    const queue: { event: TaskEvent; seq: number }[] = []
    let wake: (() => void) | null = null
    const unsubscribe = subscribe(taskId, (event, seq) => {
      queue.push({ event, seq })
      wake?.()
    })
    stream.onAbort(() => {
      unsubscribe()
      wake?.()
    })
    const opened = currentSeq()

    const resume = await catchUp(taskId, start)
    let cursor = resume === null ? await writeBacklog(stream, taskId, start, opened) : resume.from
    if (resume !== null) {
      for (const row of resume.edited) {
        cursor = await writeEvent(stream, { type: 'updated', row }, cursor)
      }
      cursor = { ...cursor, seq: opened }
      for (const row of resume.added) {
        cursor = await writeEvent(stream, { type: 'message', row }, cursor)
      }
    }
    const status = start.after === undefined ? undefined : await tasks.status(taskId)
    if (status !== undefined) {
      // A status change missed while away is not replayed, so a resume ends with the status now.
      await stream.writeSSE({ event: 'resumed', id: cursorId(cursor), data: JSON.stringify({ status }) })
    }
    const subtasks = await subtaskBriefs(taskId, openQuerySince(taskId))
    cursor = await writeEvent(stream, { type: 'subtasks', subtasks }, cursor)
    cursor = await writeEvent(stream, { type: 'todos', todos: await agentTodos(taskId) }, cursor)
    cursor = await writeEvent(stream, { type: 'session', session: sessionState(taskId) }, cursor)
    while (!stream.aborted) {
      const next = queue.shift()
      if (next) {
        cursor = await writeEvent(stream, next.event, { ...cursor, seq: next.seq })
        continue
      }
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, KEEPALIVE_MS)
      })
      wake = null
      if (queue.length === 0) {
        await stream.writeSSE({ event: 'ping', data: '' })
      }
    }
  })
