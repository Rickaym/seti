/** A tool call a script makes, by the scripted runtime's tool names (see `scripted/tools.ts`). */
export interface ScriptCall {
  tool: string
  args: Record<string, unknown>
  /** What the tool answers when it runs. */
  output?: string
  /** The tool runs and fails. */
  fails?: boolean
  /** The tool runs until the turn is interrupted; the rig notes `cancelled <tool>` then. */
  hold?: boolean
  /** The tool answers only after this many milliseconds, as a Seti tool that waits does. */
  delayMs?: number
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
  /** A line of output that is no message at all, such as a stray log line. */
  | { garbage: string }
  /** The process dies with this exit code. */
  | { exit: number }
  /** Waits until the turn is interrupted. */
  | { hold: true }
  /** Waits for an input sent during the turn; a runtime that steers takes it into this turn. */
  | { awaitInput: true }
  /** Starts a background command with this label; it ends when the next turn starts. */
  | { job: string }
  /** Runs a subagent whose steps play in its own thread; in the background its call ends first. */
  | { subagent: { label: string; steps: Step[]; background?: boolean } }
  /** The agent's plan now holds these items, in order. */
  | { plan: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  /** The runtime moves to this model on its own, as a safeguard's refusal can make it. */
  | { fallback: string }
  /** The runtime compacts the conversation, which held this many tokens before. */
  | { compact: { trigger: 'auto' | 'manual'; before: number } }

/** What the runtime does for each turn, in order; a turn past the last says its inputs back. */
export interface Script {
  turns: Step[][]
  /** The runtime answers every interrupt with an error. */
  refuseInterrupt?: boolean
  /** The launcher's environment, and whether it lacks a spawn or throws when asked to start. */
  launcher?: { env?: Record<string, string>; spawn?: 'missing' | 'throws' }
  /** Every process exits with this code before it writes anything. */
  exitAtStart?: number
  /** Processes ignore the signal to stop and never exit by themselves. */
  deaf?: boolean
}

/** The reply of a turn the script has no steps for: its inputs' text, joined by `|`. */
export const echoOf = (inputs: readonly string[]): string => `heard: ${inputs.join('|')}`

/** Reasoning a model keeps sealed for its own next call: a fake that seals sends this text. */
export const SEALED_REASONING = 'gAAAAB-sealed-reasoning-of-the-scripted-model'

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
