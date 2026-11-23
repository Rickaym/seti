import type { RuntimeEvent } from '@seti/shared'
import type { Launcher } from '../launcher.js'
import type { SessionSpec } from '../session-spec.js'

/** Names an agent runtime; Claude Code is the only one so far. */
export type RuntimeId = 'claude'

/** When an input sent during a turn reaches the agent: now, at the turn's next step, or after it. */
export type InputPriority = 'now' | 'next' | 'later'

/** What an input to the agent holds: its text, and the images sent with it as base64. */
export interface InputContent {
  text: string
  images: readonly { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string }[]
}

/** One input to a session; one sent while a turn runs has a `priority` unless someone wrote it. */
export interface SessionInput {
  id: string
  content: InputContent
  priority?: InputPriority
}

/** A message a session reported, with what Seti reads from it beside its events. */
export interface SessionMessage {
  type: 'message'
  /** The message as the runtime wrote it, which Seti stores. */
  raw: unknown
  /** What it says, the same on every runtime. */
  events: readonly RuntimeEvent[]
  /** The agent or a subagent is at work, rather than the runtime reporting on the session. */
  work: boolean
  /** The agent itself is at work, not a subagent. */
  byAgent: boolean
  /** The inputs that a turn's end reports the agent took. */
  delivered: readonly string[]
  /** The background jobs that keep the session open, where the message lists them. */
  background?: readonly string[]
}

/**
 * What became of an input sent while a turn ran: queued, taken by the agent, or dropped; 'other'
 * is a further stage the runtime reports, which counts only as the session at work.
 */
export interface InputReport {
  type: 'input'
  id: string
  state: 'queued' | 'started' | 'cancelled' | 'other'
}

/** How a session opened at a rewind point took it: applied, or refused with the runtime's reason. */
type RewindReport = { type: 'rewind'; state: 'applied' } | { type: 'rewind'; state: 'refused'; reason: string }

/** One report of an open session, in the order the runtime made them. */
export type SessionReport = SessionMessage | InputReport | RewindReport

/**
 * Where a session resumes in its conversation: after the entry `keep` names, or as a new session
 * when it is null; `dropsTurn` names the one turn the rewind drops, for the runtime to check.
 */
export interface RewindRequest {
  keep: string | null
  dropsTurn: string | null
}

/**
 * What a runtime can do where Seti would otherwise assume Claude Code. A session whose runtime
 * version lacks a control leaves that control off instead.
 */
interface Capabilities {
  /**
   * A decision can change the call's input, as an edit before allowing a held call does; and the
   * runtime has its own classifier that decides the calls no rule decides in its auto mode.
   */
  gate: { rewriteInput: boolean; classifier: boolean }
  /** Whether a session can fork, and whether the fork can stay off disk. */
  session: { fork: 'none' | 'persistent' | 'ephemeral' }
  /** A later turn can resume from an earlier prompt, and files can go back to a prompt. */
  rewind: { conversation: boolean; code: boolean }
}

/**
 * The values a runtime's sessions take and give that are still the runtime's own: what a spec
 * carries for it alone, what it realises a spec into, how Seti decides and checks its tool calls
 * and serves its own tools, its tool server reports, rules and permission modes.
 */
export interface RuntimeShapes {
  vendor: unknown
  realised: unknown
  decide: unknown
  hooks: unknown
  hostServers: unknown
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
   * The session's reports until it ends. A tool call may end after the turn that started it, as
   * background work does. A session opened at a rewind point first reports how it took it.
   */
  readonly events: AsyncIterable<SessionReport>
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
export interface RuntimeAdapter<S extends RuntimeShapes, Id extends string = RuntimeId> {
  readonly id: Id
  readonly capabilities: Capabilities
  /** What a session of the spec starts from, run by the launcher and answered by the host. */
  realise(
    spec: SessionSpec,
    launcher: Launcher,
    host: SessionHost<S>,
    abortController: AbortController,
  ): Promise<S['realised']>
  /**
   * Starts or resumes a realised session, at a rewind point when one is given; it takes its inputs
   * in order as they come and begins work when its events are first read.
   */
  open(
    realised: S['realised'],
    input: AsyncIterable<SessionInput>,
    rewind: RewindRequest | null,
  ): Promise<RuntimeSession<S>>
}
