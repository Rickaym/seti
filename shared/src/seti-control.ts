import { z } from 'zod'

/**
 * How far an agent's seti tools reach: off gives only set_status and send_file, self acts on the
 * agent itself and reads Seti, full acts on Seti as the EA does. Only the user changes it.
 */
export const SETI_CONTROL_LEVELS = ['off', 'self', 'full'] as const
export type SetiControlLevel = (typeof SETI_CONTROL_LEVELS)[number]

/** New agents act on themselves; Full stays an explicit choice of the user. */
export const DEFAULT_SETI_CONTROL: SetiControlLevel = 'self'

export const setiControlLevel = z.enum(SETI_CONTROL_LEVELS)

export const SETI_CONTROL_LABELS: Record<SetiControlLevel, string> = { off: 'Off', self: 'Self', full: 'Full' }

/** What each level lets the agent do, for the access dialog and notes. */
export const SETI_CONTROL_HINTS: Record<SetiControlLevel, string> = {
  off: 'Only its status line and file handoffs',
  self: 'Reads Seti and changes only itself',
  full: 'Runs Seti actions like the EA',
}
