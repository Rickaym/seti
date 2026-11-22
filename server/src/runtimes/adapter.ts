/** Names an agent runtime; Claude Code is the only one so far. */
export type RuntimeId = 'claude'

/**
 * Seti's driver for one agent runtime, the only code that starts the runtime's sessions. What a
 * session starts from and what it hands back are still the runtime's own shapes, so each adapter
 * names them.
 */
export interface RuntimeAdapter<Start, Session> {
  readonly id: RuntimeId
  /** Starts or resumes a session; it begins work when its prompt is first read. */
  open(start: Start): Session
}
