import type { AttachmentRef, MessageRow } from '@seti/shared'
import type { DraftAttachment } from '@/lib/attachments'

/**
 * Where a message from the reply box stands before the transcript holds its row: on its way,
 * waiting to retry, taken by the server, or given up on.
 */
type PendingState = 'sending' | 'retrying' | 'sent' | 'failed'

/** A message sent from the reply box that the transcript has no row for yet. */
export interface PendingSend {
  clientId: string
  /** The reply box text as it was sent, which Edit puts back. */
  text: string
  prompt: string
  attachments: AttachmentRef[]
  /** The draft's uploaded files: chips while pending, and back into the draft on Edit. */
  files: DraftAttachment[]
  interrupt: boolean
  state: PendingState
  /** Why the last attempt failed, while failed. */
  error: string | null
  /** When it was first sent, in ms since the epoch. */
  at: number
}

export type PendingAction =
  | { type: 'add'; send: PendingSend }
  | { type: 'retry' | 'retrying' | 'sent' | 'remove'; clientId: string }
  | { type: 'failed'; clientId: string; error: string }
  | { type: 'confirmed'; clientIds: ReadonlySet<string> }

const FROM: Record<'retry' | 'retrying' | 'sent' | 'failed', readonly PendingState[]> = {
  retry: ['failed'],
  retrying: ['sending'],
  sent: ['sending', 'retrying'],
  failed: ['sending', 'retrying'],
}

const NEXT = { retry: 'sending', retrying: 'retrying', sent: 'sent', failed: 'failed' } as const

/** The sends after one action; the same array when nothing changed. */
export function pendingReducer(sends: readonly PendingSend[], action: PendingAction): readonly PendingSend[] {
  if (action.type === 'add') {
    return sends.some((send) => send.clientId === action.send.clientId) ? sends : [...sends, action.send]
  }
  if (action.type === 'remove') {
    return drop(sends, (send) => send.clientId === action.clientId)
  }
  if (action.type === 'confirmed') {
    return drop(sends, (send) => action.clientIds.has(send.clientId))
  }
  const allowed = FROM[action.type]
  const error = action.type === 'failed' ? action.error : null
  const at = sends.findIndex((send) => send.clientId === action.clientId && allowed.includes(send.state))
  const send = sends[at]
  return send === undefined ? sends : sends.with(at, { ...send, state: NEXT[action.type], error })
}

function drop(sends: readonly PendingSend[], matches: (send: PendingSend) => boolean): readonly PendingSend[] {
  const kept = sends.filter((send) => !matches(send))
  return kept.length === sends.length ? sends : kept
}

/** The client ids of the prompt rows among `rows`, which confirm the sends that carry them. */
export function confirmedIds(rows: readonly MessageRow[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.kind === 'prompt' && row.payload.client_id !== undefined) {
      ids.add(row.payload.client_id)
    }
  }
  return ids
}

/** A file without its local preview and pasted text, which neither storage nor Edit needs. */
const bare = ({ preview: _preview, text: _text, ...file }: DraftAttachment): DraftAttachment => file

const PREFIX = 'seti.pending-sends.'
/** Older unsent messages come back failed, since the server forgets their id after a day. */
export const STALE_MS = 12 * 60 * 60 * 1000

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const isSend = (value: unknown): value is PendingSend =>
  isRecord(value) &&
  typeof value.clientId === 'string' &&
  typeof value.text === 'string' &&
  typeof value.prompt === 'string' &&
  Array.isArray(value.attachments) &&
  Array.isArray(value.files) &&
  typeof value.at === 'number'

/** What a reload brings back: unsent messages resume sending, unless they are too old. */
function revived(send: PendingSend, now: number): PendingSend {
  if (send.state === 'failed') {
    return send
  }
  return now - send.at > STALE_MS
    ? { ...send, state: 'failed', error: 'Not sent within a day; check it is not there before you retry' }
    : { ...send, state: 'sending', error: null }
}

/** Unsent messages per task in localStorage; storage that throws keeps them in view only. */
export const pendingStorage = {
  read: (taskId: string, now = Date.now()): PendingSend[] => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(PREFIX + taskId) ?? '[]')
      return Array.isArray(saved) ? saved.filter(isSend).map((send) => revived(send, now)) : []
    } catch {
      return []
    }
  },
  write: (taskId: string, sends: readonly PendingSend[]): void => {
    const kept = sends.filter((send) => send.state !== 'sent')
    try {
      if (kept.length === 0) {
        localStorage.removeItem(PREFIX + taskId)
      } else {
        localStorage.setItem(PREFIX + taskId, JSON.stringify(kept))
      }
    } catch {
      return
    }
  },
}

/** Sends one message; resolves null once the server took it, or why it failed for good. */
export type PostSend = (send: PendingSend, onRetrying: () => void) => Promise<string | null>

export interface PendingSnapshot {
  sends: readonly PendingSend[]
  /** Counts the messages sent from this page, so the transcript can follow each one. */
  added: number
}

export type NewSend = Pick<PendingSend, 'text' | 'prompt' | 'attachments' | 'files' | 'interrupt'>

/** One task's unsent messages, sent one at a time in the order they were written. */
export interface PendingStore {
  subscribe: (listener: () => void) => () => void
  snapshot: () => PendingSnapshot
  add: (send: NewSend) => void
  retry: (clientId: string) => void
  /** Takes a failed message out of the transcript and hands it to the reply box. */
  edit: (clientId: string) => void
  /** Drops a failed message for good. */
  discard: (clientId: string) => void
  /** Drops the messages whose rows the transcript now holds. */
  confirm: (clientIds: ReadonlySet<string>) => void
  /** Receives each message Edit takes back. */
  onEdit: (listener: (send: PendingSend) => void) => () => void
}

interface StoreDeps {
  post: PostSend
  storage?: typeof pendingStorage
  now?: () => number
  newId?: () => string
}

export function createPendingStore(taskId: string, deps: StoreDeps): PendingStore {
  const { post, storage = pendingStorage, now = Date.now, newId = () => crypto.randomUUID() } = deps
  let state: PendingSnapshot = { sends: storage.read(taskId, now()), added: 0 }
  let queue = Promise.resolve()
  let resumed = false
  const listeners = new Set<() => void>()
  const editors = new Set<(send: PendingSend) => void>()

  const update = (next: PendingSnapshot) => {
    if (next.sends !== state.sends) {
      storage.write(taskId, next.sends)
    }
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  const dispatch = (action: PendingAction) => {
    const sends = pendingReducer(state.sends, action)
    if (sends !== state.sends) {
      update({ ...state, sends })
    }
  }

  const deliver = async (clientId: string) => {
    const send = state.sends.find((other) => other.clientId === clientId)
    if (send?.state !== 'sending') {
      return
    }
    const error = await post(send, () => {
      dispatch({ type: 'retrying', clientId })
    }).catch((e: unknown) => (e instanceof Error ? e.message : 'The message could not be sent'))
    dispatch(error === null ? { type: 'sent', clientId } : { type: 'failed', clientId, error })
  }

  const enqueue = (clientId: string) => {
    queue = queue.then(async () => deliver(clientId))
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      if (!resumed) {
        resumed = true
        for (const send of state.sends) {
          enqueue(send.clientId)
        }
      }
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => state,
    add: (send) => {
      const added: PendingSend = {
        ...send,
        files: send.files.map(bare),
        clientId: newId(),
        state: 'sending',
        error: null,
        at: now(),
      }
      update({ sends: pendingReducer(state.sends, { type: 'add', send: added }), added: state.added + 1 })
      enqueue(added.clientId)
    },
    retry: (clientId) => {
      dispatch({ type: 'retry', clientId })
      enqueue(clientId)
    },
    edit: (clientId) => {
      const send = state.sends.find((other) => other.clientId === clientId)
      if (send?.state !== 'failed') {
        return
      }
      dispatch({ type: 'remove', clientId })
      for (const editor of editors) {
        editor(send)
      }
    },
    discard: (clientId) => {
      if (state.sends.find((other) => other.clientId === clientId)?.state === 'failed') {
        dispatch({ type: 'remove', clientId })
      }
    },
    confirm: (clientIds) => {
      dispatch({ type: 'confirmed', clientIds })
    },
    onEdit: (listener) => {
      editors.add(listener)
      return () => {
        editors.delete(listener)
      }
    },
  }
}
