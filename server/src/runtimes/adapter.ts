/** Names an agent runtime; Claude Code is the only one so far. */
export type RuntimeId = 'claude'

/**
 * The values a runtime's sessions take and give that are still the runtime's own: what a session
 * starts from, the messages it streams, its tool server reports, rules and permission modes.
 */
interface RuntimeShapes {
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

/** Seti's driver for one agent runtime, the only code that starts the runtime's sessions. */
export interface RuntimeAdapter<S extends RuntimeShapes> {
  readonly id: RuntimeId
  /** Starts or resumes a session; it begins work when its events are first read. */
  open(start: S['start']): Promise<RuntimeSession<S>>
}
