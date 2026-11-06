import type { AttentionBrief, EaAskState, EaRepliesSeenInput, EaUnseenReplies, EaUnseenReply } from '@seti/shared'

/** More plain unseen messages than this fold into the brief; questions always stand alone. */
const COLLAPSE_ABOVE = 3

/** Time a visible EA chat gets to mark a new reply seen before another device toasts it. */
export const SETTLE_MS = 4000

export interface ReplyToastInput {
  page: EaUnseenReplies | undefined
  /** The since-you-left brief Seti built when the user came back. */
  brief: AttentionBrief | null
  /** An EA call is connecting or live on this page; the EA says the brief there. */
  calling: boolean
  /** The EA chat is open and on screen here. */
  chatShown: boolean
  /** The active tier raises toasts; otherwise EA messages wait for the brief. */
  toasts: boolean
  now: number
}

export type ReplyToast =
  | { kind: 'reply'; key: string; reply: EaUnseenReply }
  | {
      kind: 'brief'
      key: string
      brief: AttentionBrief | null
      /** Plain EA messages folded in, oldest first, and how many more wait past the page. */
      replies: EaUnseenReply[]
      beyond: number
      seen: EaRepliesSeenInput | null
    }

export const BRIEF_KEY = 'ea-reply:brief'
export const replyKey = (id: number) => `ea-reply:${String(id)}`

const settled = (reply: EaUnseenReply, now: number) => now - Date.parse(reply.created_at) >= SETTLE_MS

function seenOf(ids: number[], beyond: number, oldest: number): EaRepliesSeenInput | null {
  const through = beyond > 0 ? { through: oldest - 1 } : {}
  if (ids.length === 0) {
    return beyond > 0 ? { through: oldest - 1 } : null
  }
  return { ids, ...through }
}

/**
 * Which toasts the unseen EA messages and the brief raise here: none while a call runs. Questions
 * stand alone. Plain messages fold into one brief toast when a brief waits or more than three
 * do; otherwise each gets its own, while the active tier toasts and the EA chat is off screen.
 */
export function replyToasts({ page, brief, calling, chatShown, toasts, now }: ReplyToastInput): ReplyToast[] {
  if (calling) {
    return []
  }
  const ready = chatShown ? [] : (page?.replies ?? []).filter((reply) => settled(reply, now))
  const plain = ready.filter((reply) => reply.asks.length === 0)
  const beyond = chatShown || page === undefined ? 0 : page.total - page.replies.length
  const each = toasts ? ready.filter((reply) => reply.asks.length > 0) : []
  const asking = each.map((reply): ReplyToast => ({ kind: 'reply', key: replyKey(reply.id), reply }))
  const fold = brief !== null || (toasts && plain.length + beyond > COLLAPSE_ABOVE)
  if (!fold) {
    const single = toasts ? plain.map((reply): ReplyToast => ({ kind: 'reply', key: replyKey(reply.id), reply })) : []
    return [...single, ...asking]
  }
  const oldest = page?.replies[0]?.id ?? 1
  const seen = seenOf(
    plain.map((reply) => reply.id),
    beyond,
    oldest,
  )
  return [{ kind: 'brief', key: BRIEF_KEY, brief, replies: plain, beyond, seen }, ...asking]
}

/** The newest reply that is not ready to toast yet, so the page can look again once it is. */
export function nextSettle(page: EaUnseenReplies | undefined, now: number): number | null {
  const waiting = (page?.replies ?? []).filter((reply) => !settled(reply, now))
  const last = waiting.at(-1)
  return last === undefined ? null : Date.parse(last.created_at) + SETTLE_MS - now
}

/** How a question that is no longer open reads under its reply. */
export const ASK_OUTCOMES: Record<Exclude<EaAskState, 'pending'>, string> = {
  expired: 'Expired',
  allowed: 'Allowed',
  denied: 'Denied',
  done: 'Done',
  failed: 'Failed',
}

/** A question as its button row names it: `delete agent X` reads `Delete agent X`. */
export const askLabel = (summary: string) => summary.charAt(0).toUpperCase() + summary.slice(1)
