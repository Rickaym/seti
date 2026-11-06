import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { TaskEvent } from '@seti/shared'
import { broadcast, listen } from './redis.js'

const bus = new EventEmitter()
bus.setMaxListeners(0)

/** Tells this process's events apart from those other processes relay over Redis. */
const ORIGIN = randomUUID()
const CHANNEL = 'task:'

interface Relayed {
  origin: string
  event: TaskEvent
}

type AnyListener = (taskId: string, event: TaskEvent) => void

/** Hears one task's events with their place in this process's sequence of events. */
type TaskListener = (event: TaskEvent, seq: number) => void

const anyListeners: AnyListener[] = []

/** Tells a stream position this process handed out apart from one of an earlier run. */
export const STREAM_EPOCH = randomUUID().slice(0, 8)

/** Row edits each task remembers, so a resuming stream can send the rows edited while it was away. */
const EDITS_KEPT = 500
/** Tasks whose edits are remembered; the one edited longest ago is forgotten first. */
const TASKS_KEPT = 1000

interface EditLog {
  /** The sequence number of the newest edit forgotten; a stream from before it cannot resume. */
  floor: number
  edits: { seq: number; rowId: number }[]
}

let seq = 0
const edits = new Map<string, EditLog>()
/** The newest edit of any task whose whole log was forgotten. */
let forgotten = 0

function remember(taskId: string, at: number, rowId: number): void {
  const log = edits.get(taskId) ?? { floor: forgotten, edits: [] }
  edits.delete(taskId)
  edits.set(taskId, log)
  log.edits.push({ seq: at, rowId })
  if (log.edits.length > EDITS_KEPT) {
    log.floor = log.edits.shift()?.seq ?? log.floor
  }
  for (const [oldest, dropped] of edits) {
    if (edits.size <= TASKS_KEPT) {
      break
    }
    edits.delete(oldest)
    forgotten = Math.max(forgotten, dropped.edits.at(-1)?.seq ?? dropped.floor)
  }
}

/** The sequence number of this process's newest task event. */
export const currentSeq = () => seq

/** Ids of the task's rows edited after `since`, or null when the log does not reach back that far. */
export function editedSince(taskId: string, since: number): number[] | null {
  if (since > seq) {
    return null
  }
  const log = edits.get(taskId)
  if (log === undefined) {
    return since >= forgotten ? [] : null
  }
  if (since < log.floor) {
    return null
  }
  return [...new Set(log.edits.filter((edit) => edit.seq > since).map((edit) => edit.rowId))]
}

function emit(taskId: string, event: TaskEvent): void {
  seq += 1
  if (event.type === 'updated') {
    remember(taskId, seq, event.row.id)
  }
  bus.emit(taskId, event, seq)
  for (const listener of anyListeners) {
    listener(taskId, event)
  }
}

/** Hears every task's events, from this process and relayed from others. */
export function onAnyTaskEvent(listener: AnyListener): void {
  anyListeners.push(listener)
}

export function subscribe(taskId: string, listener: TaskListener): () => void {
  bus.on(taskId, listener)
  return () => bus.off(taskId, listener)
}

/** Delivers to this process's streams at once and to other processes' streams through Redis. */
export function publish(taskId: string, event: TaskEvent): void {
  emit(taskId, event)
  void broadcast(`${CHANNEL}${taskId}`, JSON.stringify({ origin: ORIGIN, event } satisfies Relayed))
}

/** Hands events that other processes publish to this process's streams. */
export function relayTaskEvents(): void {
  listen(`${CHANNEL}*`, (channel, message) => {
    const relayed = JSON.parse(message) as Relayed
    if (relayed.origin !== ORIGIN) {
      emit(channel.slice(CHANNEL.length), relayed.event)
    }
  })
}
