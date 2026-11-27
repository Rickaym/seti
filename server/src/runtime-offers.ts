import os from 'node:os'
import {
  claudeOffer,
  codexOffer,
  geminiOffer,
  pickRefusal,
  startRuntime,
  type CapabilitiesSnapshot,
  type CodexStatus,
  type GeminiStatus,
  type RuntimeOffer,
  type StoredRuntime,
} from '@seti/shared'
import { capabilityCache } from './capabilities.js'
import { HttpError } from './http.js'

const newest = (snapshots: readonly CapabilitiesSnapshot[]) =>
  snapshots.toSorted((a, b) => b.probed_at.localeCompare(a.probed_at))[0]

/** The account's Claude Code models as the last probe this process holds reported them. */
function reportedClaudeModels() {
  const snapshot = capabilityCache.cached(os.homedir()) ?? newest(capabilityCache.all())
  return snapshot?.models ?? null
}

/** Claude Code always, and Codex and Gemini CLI only while a new agent may start on them. */
export const runtimeOffers = (codex: CodexStatus, gemini: GeminiStatus): RuntimeOffer[] => [
  claudeOffer(reportedClaudeModels()),
  ...(codex.state === 'ready' ? [codexOffer()] : []),
  ...(gemini.state === 'ready' ? [geminiOffer()] : []),
]

/** Every runtime's offer, whether or not it can start an agent now, in the order Seti offers them. */
export const everyOffer = (): RuntimeOffer[] => [claudeOffer(reportedClaudeModels()), codexOffer(), geminiOffer()]

interface Picks {
  runtime?: StoredRuntime | undefined
  model?: string | undefined
  effort?: string | undefined
}

/**
 * The runtime a start runs on, from what it names and every runtime's models whether or not it
 * can start now; a model, runtime or effort that does not fit is refused with the reason.
 */
export function pickedRuntime(picks: Picks): StoredRuntime {
  const offers = everyOffer()
  const refusal = pickRefusal(picks, offers)
  if (refusal !== null) {
    throw new HttpError(400, refusal)
  }
  return startRuntime(picks, offers)
}
