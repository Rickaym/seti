import type { Decision, Verdict } from './types.js'

/** What Claude Code did with a call: ran it, asked, denied it, or gave it to its classifier. */
export type ClaudeOutcome = 'allow' | 'classifier' | 'ask' | 'deny'

/**
 * How Seti's decision stands to Claude Code's: the same, looser (Seti would let through what
 * Claude Code stopped), tighter, deferred (Seti hands to the classifier a call Claude Code ran or
 * denied, which may have been the classifier's own answer), or decided by Seti's hooks first.
 */
export type ShadowClass = 'agree' | 'looser' | 'tighter' | 'deferred' | 'seti-hook'

const SETI_RANK: Record<Verdict, number> = { allow: 0, defer: 1, ask: 2, review: 2, deny: 3 }
const CLAUDE_RANK: Record<ClaudeOutcome, number> = { allow: 0, classifier: 1, ask: 2, deny: 3 }

export function compareOutcomes(seti: Decision, claude: ClaudeOutcome): ShadowClass {
  if (seti.step === 'guard' || seti.verdict === 'review') {
    return 'seti-hook'
  }
  if (seti.verdict === 'defer' && (claude === 'allow' || claude === 'deny')) {
    return 'deferred'
  }
  const difference = SETI_RANK[seti.verdict] - CLAUDE_RANK[claude]
  if (difference === 0) {
    return 'agree'
  }
  return difference < 0 ? 'looser' : 'tighter'
}
