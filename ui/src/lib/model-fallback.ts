import {
  fallbackReason,
  fallbackSentence,
  modelLabel,
  movesSession,
  switchableModel,
  type EventOf,
  type ModelFallback,
  type Refusal,
} from '@seti/shared'
import { urlPieces } from '@/lib/links/bare-urls'

/** A switch to another model after a safeguard refused a request. */
export type RefusalChange = EventOf<'model.changed'> & { refusal: Refusal }

/** The Cyber Verification Program link, when Claude Code reported the account's verification. */
export function verificationLink({ refusal }: RefusalChange): string | null {
  const { verification } = refusal
  if (verification === undefined) {
    return null
  }
  if (verification.url?.startsWith('https://') === true) {
    return verification.url
  }
  const links = urlPieces(refusal.explanation ?? '').flatMap((part) => part.href ?? [])
  return links.find((href) => href.includes('cyber-verification')) ?? null
}

/** What the notice says happened. */
export function noticeSentence(change: RefusalChange): string {
  const fallback = { original_model: change.from, fallback_model: change.to, category: change.refusal.category ?? null }
  if (movesSession(change.refusal)) {
    return fallbackSentence(fallback)
  }
  const [from, to] = [modelLabel(change.from), modelLabel(change.to)]
  return `Claude Code answered one subagent request on ${to} after ${fallbackReason(fallback.category)}; the agent stays on ${from}.`
}

/** Whether the task still runs on the fallback this notice reported, so Switch back applies. */
export const stillOn = (change: RefusalChange, now: ModelFallback | null | undefined): now is ModelFallback =>
  now !== null &&
  now !== undefined &&
  movesSession(change.refusal) &&
  now.original_model === change.from &&
  now.fallback_model === change.to &&
  switchableModel(now.original_model)

/** The tooltip of the header's Fallback mark. */
export const fallbackHint = (f: ModelFallback): string =>
  `On ${modelLabel(f.fallback_model)} since ${fallbackReason(f.category)}; Switch back returns it to ${modelLabel(f.original_model)}`
