/** A tool call a script makes, by the scripted runtime's tool names (see `scripted/tools.ts`). */
export interface ScriptCall {
  tool: string
  args: Record<string, unknown>
  /** What the tool answers when it runs. */
  output?: string
  /** The tool runs and fails. */
  fails?: boolean
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

/** What the runtime does for each turn, in order; a turn past the last says its inputs back. */
export interface Script {
  turns: Step[][]
}

/** The reply of a turn the script has no steps for: its inputs' text, joined by `|`. */
export const echoOf = (inputs: readonly string[]): string => `heard: ${inputs.join('|')}`
