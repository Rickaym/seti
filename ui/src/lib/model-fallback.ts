import {
  fallbackReason,
  fallbackSentence,
  modelLabel,
  movesSession,
  switchableModel,
  type ModelFallback,
  type ModelFallbackMessage,
} from '@seti/shared'

/** A run of text, or a link when `href` is set. */
export interface TextPart {
  text: string
  href?: string
}

const LINK = /https:\/\/[^\s<>"'()]+/g
const TRAILING = new Set(['.', ',', ';', ':', '!', '?'])

/** The link without the sentence punctuation that follows it. */
function trimmed(link: string): string {
  let end = link.length
  while (end > 0 && TRAILING.has(link.charAt(end - 1))) {
    end -= 1
  }
  return link.slice(0, end)
}

/** Splits prose into text and https links, leaving sentence punctuation outside the links. */
export function linkParts(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0
  for (const match of text.matchAll(LINK)) {
    const href = trimmed(match[0])
    if (match.index > at) {
      parts.push({ text: text.slice(at, match.index) })
    }
    parts.push({ text: href, href })
    at = match.index + href.length
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at) })
  }
  return parts
}

/** The Cyber Verification Program link, when Claude Code reported the account's verification. */
export function verificationLink(m: ModelFallbackMessage): string | null {
  const verification = m.api_refusal_cyber_verification
  if (verification === null || verification === undefined) {
    return null
  }
  if (verification.url?.startsWith('https://') === true) {
    return verification.url
  }
  const links = linkParts(m.api_refusal_explanation ?? '').flatMap((part) => part.href ?? [])
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
