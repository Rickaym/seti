import type { EaAsk, EaAskDecision, EaRepliesSeenInput, EaUnseenReplies } from '@seti/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { apiPost } from '@/api'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'

const replies = createPolledResource<EaUnseenReplies>('/ea/replies', 10_000)

/** The EA messages the user has not seen, on every device alike. */
export const useEaReplies = () => usePolled(replies)

const refreshEaReplies = () => {
  replies.refresh()
}

/** Marks EA messages seen for every device; throws when Seti refuses. */
export async function markRepliesSeen(input: EaRepliesSeenInput): Promise<void> {
  await apiPost('/ea/replies/seen', input)
  refreshEaReplies()
}

/** The user's Allow or Deny for one question; throws with Seti's reason, such as an expired one. */
export async function answerAsk(id: number, decision: EaAskDecision): Promise<EaAsk> {
  try {
    return await apiPost<EaAsk>(`/ea/asks/${String(id)}/decision`, { decision })
  } finally {
    refreshEaReplies()
  }
}

let shown = 0
const listeners = new Set<() => void>()

function setShown(next: number) {
  shown = next
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** True while an EA chat is open and on screen in this page. */
export const useEaChatShown = () => useSyncExternalStore(subscribe, () => shown > 0)

/** Counts the calling chat as on screen while it is mounted and the page is visible. */
export function useShowEaChat(): void {
  useEffect(() => {
    let counted = false
    const sync = () => {
      const visible = document.visibilityState === 'visible'
      if (visible !== counted) {
        counted = visible
        setShown(shown + (visible ? 1 : -1))
      }
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
      if (counted) {
        setShown(shown - 1)
      }
    }
  }, [])
}

let focus: number | null = null

/** Asks the EA chat to bring a message into view when it next shows it. */
export function focusEaMessage(id: number): void {
  focus = id
}

/** The message the EA chat should bring into view, once. */
export function takeEaFocus(available: (id: number) => boolean): number | null {
  if (focus === null || !available(focus)) {
    return null
  }
  const id = focus
  focus = null
  return id
}
