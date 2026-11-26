import type { StoredRuntime } from '@seti/shared'
import { codexSettings } from './store/codex-settings.js'
import { geminiSettings } from './store/gemini-settings.js'

/**
 * Whether the user lets Seti's rules answer the calls of agents the runtime supervises: Gemini's
 * own setting for a Gemini agent, Codex's for a Codex agent and for one held to Codex's regime.
 */
export const rulesDecide = async (runtime: StoredRuntime): Promise<boolean> =>
  (runtime === 'gemini' ? await geminiSettings.get() : await codexSettings.get()).evaluator_decides
