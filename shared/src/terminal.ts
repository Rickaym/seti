import { z } from 'zod'

/** Characters one input message may carry; the UI sends a longer paste in several. */
export const TERMINAL_INPUT_CHARS = 8192

const cols = z.coerce.number().int().min(2).max(1000)
const rows = z.coerce.number().int().min(1).max(500)

const terminalSize = z.object({ cols, rows })

export type TerminalSize = z.infer<typeof terminalSize>

/** A terminal's id, which the browser picks as it opens a tab, so a reload finds it again. */
export const terminalParams = z.object({ id: z.uuid() })

/** Where and how a terminal opens, from the query of its WebSocket URL, at the size it opens at. */
export const terminalQuery = terminalSize.extend({
  /** The agent whose directory and sandbox the shell runs in; none opens it in the home folder. */
  task: z.string().min(1).optional(),
  /** Only reattach: a terminal that ended is not started again. */
  resume: z.literal('1').optional(),
  /** The shell this browser showed before it lost the socket, as `ready` named it. */
  shell: z.uuid().optional(),
  /** How many bytes of that shell's output this browser already has. */
  at: z.coerce.number().int().min(0).optional(),
})

/** What the browser sends as text frames: keystrokes and pastes, or a new size. */
export const terminalClientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(TERMINAL_INPUT_CHARS) }),
  z.object({ type: z.literal('resize'), cols, rows }),
])

export type TerminalClientMessage = z.infer<typeof terminalClientMessage>

/**
 * Why a connection lost its terminal: the shell exited, the user stopped it, another window took
 * it, the agent's sandbox or directory changed, the agent was archived or deleted, no window
 * showed it for too long, Seti stopped, the browser sent too much, the shell could not start, or
 * it had ended before the browser came back.
 */
export const TERMINAL_CLOSES = [
  'exited',
  'stopped',
  'replaced',
  'settings',
  'archived',
  'deleted',
  'idle',
  'shutdown',
  'flood',
  'failed',
  'gone',
] as const

export type TerminalClose = (typeof TERMINAL_CLOSES)[number]

/** What the server sends as text frames; the shell's output arrives as binary frames. */
export const terminalServerMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ready'),
    /** The terminal was already running; its recent output came first. */
    reattached: z.boolean(),
    /** Names this shell, so a browser that reconnects can ask for only what it missed. */
    shell: z.uuid(),
    /** Where in the shell's output the bytes that follow begin. */
    from: z.number().int().min(0),
    sandboxed: z.boolean(),
    cwd: z.string(),
  }),
  z.object({
    type: z.literal('closed'),
    reason: z.enum(TERMINAL_CLOSES),
    exit_code: z.number().int().nullable(),
    detail: z.string(),
  }),
])

export type TerminalServerMessage = z.infer<typeof terminalServerMessage>

/** A live terminal, as its agent's Processes view and a stop show it. */
export const terminalStatusSchema = z.object({
  id: z.string(),
  /** The agent it runs for, or null for a shell in the home folder. */
  task_id: z.string().nullable(),
  /** Host pid of the process the terminal started: the shell, its sandbox or its scope. */
  pid: z.number().int(),
  shell: z.string(),
  cwd: z.string(),
  sandboxed: z.boolean(),
  started_at: z.string(),
  /** A browser shows it now. */
  attached: z.boolean(),
  /** When it ends unless a browser opens it again; null while one shows it. */
  ends_at: z.string().nullable(),
})

export type TerminalStatus = z.infer<typeof terminalStatusSchema>
