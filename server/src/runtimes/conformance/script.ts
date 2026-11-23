/** A tool call a script makes, by the scripted runtime's tool names (see `scripted/tools.ts`). */
export interface ScriptCall {
  tool: string
  args: Record<string, unknown>
  /** What the tool answers when it runs. */
  output?: string
  /** The tool runs and fails. */
  fails?: boolean
  /** The tool runs until the turn is interrupted. */
  hold?: boolean
}

/**
 * One thing the runtime does in a turn, in neutral terms. The scripted runtime plays these
 * directly; another adapter's rig turns each into what its runtime would send.
 */
export type Step =
  | { say: string }
  | { think: string }
  | { call: ScriptCall }
  /** Says the text of every input the session read so far, across processes, joined by `|`. */
  | { recall: true }
  /** A message the runtime knows the type of, in a shape the projector cannot read. */
  | { malformed: true }
  /** A message of a type the adapter has no mapping for. */
  | { unknown: string }
  /** The process dies with this exit code. */
  | { exit: number }
  /** Waits until the turn is interrupted. */
  | { hold: true }
  /** Waits for an input sent during the turn; a runtime that steers takes it into this turn. */
  | { awaitInput: true }
  /** Starts a background command with this label; it ends when the next turn starts. */
  | { job: string }

/** What the runtime does for each turn, in order; a turn past the last says its inputs back. */
export interface Script {
  turns: Step[][]
  /** The runtime answers every interrupt with an error. */
  refuseInterrupt?: boolean
}

/** The reply of a turn the script has no steps for: its inputs' text, joined by `|`. */
export const echoOf = (inputs: readonly string[]): string => `heard: ${inputs.join('|')}`

/** A turn that uses most of what a runtime reports: reasoning, text, and calls of several kinds. */
export const VARIED: Step[] = [
  { think: 'plan the work' },
  { say: 'looking around' },
  { call: { tool: 'sh', args: { cmd: 'ls' }, output: 'README.md' } },
  { call: { tool: 'cat', args: { path: 'README.md' }, output: '# Readme' } },
  { call: { tool: 'grep', args: { pattern: 'TODO' }, output: 'none' } },
  { call: { tool: 'fetch', args: { url: 'https://example.com/' }, output: 'page' } },
  { call: { tool: 'patch', args: { path: 'README.md', diff: '-a\n+b\n' }, output: 'patched' } },
  { call: { tool: 'seti.list_agents', args: {}, output: '[]' } },
  { call: { tool: 'frobnicate', args: { level: 3 }, output: 'frobbed' } },
  { say: 'all done' },
]
