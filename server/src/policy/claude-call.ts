import type { PolicyMode } from './types.js'

const MODES: Record<string, PolicyMode> = { auto: 'auto', bypassPermissions: 'bypass', plan: 'plan' }

/** Claude Code's permission mode as the evaluator's; any mode Seti does not run asks. */
export const policyMode = (claudeMode: string | undefined): PolicyMode => MODES[claudeMode ?? ''] ?? 'ask'
