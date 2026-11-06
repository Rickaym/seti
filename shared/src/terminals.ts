import { z } from 'zod'

/** The most characters in a terminal's name. */
export const TERMINAL_NAME_MAX = 40

/** A terminal Seti keeps; `task` is the agent whose folder its shell runs in. */
export const terminalRef = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(TERMINAL_NAME_MAX),
  task: z.string().min(1).max(128).nullable(),
})

export type TerminalRef = z.infer<typeof terminalRef>
