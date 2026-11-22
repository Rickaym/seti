import {
  fallbackReason,
  fallbackSentence,
  modelLabel,
  movesSession,
  switchableModel,
  type ModelFallback,
  type ModelFallbackMessage,
} from '@seti/shared'
import { urlPieces } from '@/lib/links/bare-urls'

/** The Cyber Verification Program link, when Claude Code reported the account's verification. */
export function verificationLink(m: ModelFallbackMessage): string | null {
  const verification = m.api_refusal_cyber_verification
  if (verification === null || verification === undefined) {
    return null
  }
  if (verification.url?.startsWith('https://') === true) {
    return verification.url
  }
  const links = urlPieces(m.api_refusal_explanation ?? '').flatMap((part) => part.href ?? [])
  return links.find((href) => href.includes('cyber-verification')) ?? null
}

/** What the notice says happened. */
export function noticeSentence(m: ModelFallbackMessage): string {
  const fallback = { ...m, category: m.api_refusal_category ?? null }
  if (movesSession(m)) {
    return fallbackSentence(fallback)
  }
  const [from, to] = [modelLabel(m.original_model), modelLabel(m.fallback_model)]
  return `Claude Code answered one subagent request on ${to} after ${fallbackReason(fallback.category)}; the agent stays on ${from}.`
}

/** Whether the task still runs on the fallback this notice reported, so Switch back applies. */
export const stillOn = (m: ModelFallbackMessage, now: ModelFallback | null | undefined): now is ModelFallback =>
  now !== null &&
  now !== undefined &&
  movesSession(m) &&
  now.original_model === m.original_model &&
  now.fallback_model === m.fallback_model &&
  switchableModel(now.original_model)

/** The tooltip of the header's Fallback mark. */
export const fallbackHint = (f: ModelFallback): string =>
  `On ${modelLabel(f.fallback_model)} since ${fallbackReason(f.category)}; Switch back returns it to ${modelLabel(f.original_model)}`
