import type { SendMessageInput } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { apiSend, errorText } from '@/api'
import { appLink } from '@/lib/app-link'
import {
  createPendingStore,
  type NewSend,
  type PendingSnapshot,
  type PendingStore,
  type PostSend,
} from '@/lib/pending-sends'
import { linkConnectivity } from '@/lib/send-retry'

const connectivity = linkConnectivity(appLink)

const postTo =
  (taskId: string): PostSend =>
  async (send, onRetrying) => {
    const body = {
      prompt: send.prompt,
      interrupt: send.interrupt,
      client_id: send.clientId,
      ...(send.attachments.length === 0 ? {} : { attachments: send.attachments }),
      ...(send.via === undefined ? {} : { via: send.via }),
    } satisfies SendMessageInput
    try {
      await apiSend(`/tasks/${taskId}/messages`, body, { connectivity, onRetrying })
      return null
    } catch (e) {
      return errorText(e)
    }
  }

/** One store per task for the page's life, so sends carry on while another task is open. */
const stores = new Map<string, PendingStore>()

function pendingStore(taskId: string): PendingStore {
  let store = stores.get(taskId)
  if (store === undefined) {
    store = createPendingStore(taskId, { post: postTo(taskId) })
    stores.set(taskId, store)
  }
  return store
}

/** Resolves null once the server took the message, or with why it gave up on it. */
async function settled(store: PendingStore, clientId: string): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = store.subscribe(() => {
      const send = store.snapshot().sends.find((other) => other.clientId === clientId)
      if (send?.state === 'sending' || send?.state === 'retrying') {
        return
      }
      stop()
      resolve(send?.state === 'failed' ? (send.error ?? 'The message could not be sent') : null)
    })
  })
}

/**
 * Sends text to the task as the user's own message, as its reply box does, queued while it runs.
 * Resolves null once the server took it, or with the reason when it could not be sent.
 */
export async function sendAsUser(taskId: string, text: string): Promise<string | null> {
  const store = pendingStore(taskId)
  return settled(store, store.add({ text, prompt: text, attachments: [], files: [], interrupt: false }))
}

/** Sends a message from the Share page as the user's own, through the reply box's queue. */
export function sendShared(taskId: string, send: Omit<NewSend, 'interrupt' | 'via'>): void {
  pendingStore(taskId).add({ ...send, interrupt: false, via: 'share' })
}

export interface PendingSends extends PendingSnapshot {
  store: PendingStore
}

/** The task's messages that the server has not confirmed yet, and the store that sends them. */
export function usePendingSends(taskId: string): PendingSends {
  const store = pendingStore(taskId)
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot)
  return { store, ...snapshot }
}
