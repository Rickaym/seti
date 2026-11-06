import type { SendMessageInput } from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { apiSend, errorText } from '@/api'
import { appLink } from '@/lib/app-link'
import { createPendingStore, type PendingSnapshot, type PendingStore, type PostSend } from '@/lib/pending-sends'
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

export interface PendingSends extends PendingSnapshot {
  store: PendingStore
}

/** The task's messages that the server has not confirmed yet, and the store that sends them. */
export function usePendingSends(taskId: string): PendingSends {
  const store = pendingStore(taskId)
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot)
  return { store, ...snapshot }
}
