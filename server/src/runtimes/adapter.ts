import type { Launcher } from '../launcher.js'
import type { SessionSpec } from '../session-spec.js'

/** Names an agent runtime; Claude Code is the only one so far. */
export type RuntimeId = 'claude'

/**
 * What a runtime can do where Seti would otherwise assume Claude Code. A session whose runtime
 * version lacks a control leaves that control off instead.
 */
interface Capabilities {
  /** A decision can change the call's input, as an edit before allowing a held call does. */
  gate: { rewriteInput: boolean }
  /** Whether a session can fork, and whether the fork can stay off disk. */
  session: { fork: 'none' | 'persistent' | 'ephemeral' }
  /** A later turn can resume from an earlier prompt, and files can go back to a prompt. */
  rewind: { conversation: boolean; code: boolean }
}

/**
 * The values a runtime's sessions take and give that are still the runtime's own: what a spec
 * carries for it alone, what it realises a spec into, how Seti decides and checks its tool calls
 * and serves its own tools, what a session starts from, the messages it streams, its tool server
 * reports, rules and permission modes.
 */
interface RuntimeShapes {
  vendor: unknown
  realised: unknown
  decide: unknown
  hooks: unknown
  hostServers: unknown
  start: unknown
  message: unknown
  toolServer: unknown
  policy: unknown
  mode: unknown
}

/**
 * One open session of a runtime. An optional control is absent where the runtime, or the version
 * installed, cannot do what it does; each is a plain function, safe to call unbound.
 */
export interface RuntimeSession<S extends RuntimeShapes> {
  /**
   * The runtime's messages until the session ends. A tool call may end after the turn that
   * started it, as background work does.
   */
  readonly events: AsyncIterable<S['message']>
  /**
   * Ends the running turn and every tool call it started; work the agent put in the background
   * keeps running and stays reported. Resolves once the runtime took the request.
   */
  interrupt(): Promise<void>
  /** Ends the process and everything running in it. */
  close(): void
  /** Takes back a message the runtime queued for the running turn; false once the agent read it. */
  readonly retract?: (inputId: string) => Promise<boolean>
  /** Stops one subagent or background command the session started. */
  readonly stopBackground?: (jobId: string) => Promise<void>
  /** How the session's tool servers connected. */
  readonly toolServers?: () => Promise<S['toolServer'][]>
  /** The context window usage is measured against; null when the runtime cannot say in time. */
  readonly contextWindow?: () => Promise<number | null>
  /** Hands the running process new rules, which apply from its next tool call. */
  readonly setPolicy?: (policy: S['policy']) => Promise<void>
  /** Switches the running process's permission mode. */
  readonly setMode?: (mode: S['mode']) => Promise<void>
}

/** What Seti answers while a session's turn waits on it, until the session ends. */
export interface SessionHost<S extends RuntimeShapes> {
  /**
   * Decides a tool call the runtime asks about. The reply allows the call, possibly with changed
   * input where the runtime lets a reply change it, or denies it with a message.
   */
  readonly decide: S['decide']
  /** The checks around tool calls, subagent starts and compaction. */
  readonly hooks: S['hooks']
  /** The tool servers that run in Seti's own process. */
  readonly toolServers: S['hostServers']
}

/** Seti's driver for one agent runtime, the only code that starts the runtime's sessions. */
export interface RuntimeAdapter<S extends RuntimeShapes> {
  readonly id: RuntimeId
  readonly capabilities: Capabilities
  /** What a session of the spec starts from, run by the launcher and answered by the host. */
  realise(
    spec: SessionSpec,
    launcher: Launcher,
    host: SessionHost<S>,
    abortController: AbortController,
  ): Promise<S['realised']>
  /** Starts or resumes a session; it begins work when its events are first read. */
  open(start: S['start']): Promise<RuntimeSession<S>>
}
