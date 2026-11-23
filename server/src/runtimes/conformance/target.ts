import type { RuntimeEvent, ToolCall } from '@seti/shared'
import type { Launcher } from '../../launcher.js'
import type { RuntimeAdapter, RuntimeShapes, SessionHost } from '../adapter.js'
import type { Script } from './script.js'

/**
 * What the suite reads about a runtime that `Capabilities` does not state yet (design C.2). Each
 * field moves to `Capabilities` when code outside the suite first needs it.
 */
export interface Profile {
  events: {
    /** The runtime marks a turn's start (`turn.started`). */
    turnStart: boolean
    reasoning: boolean
    /** Subagents' events carry their own thread. */
    threads: boolean
    /** The runtime reports its plan, as a plan call or a plan event. */
    plan: boolean
    /** The runtime reports when it compacts the conversation. */
    compaction: boolean
    /** The runtime can move to another model by itself, and says so. */
    modelFallback: boolean
  }
  usage: { tokens: boolean; costUsd: 'reported' | 'priced' | 'none' }
  /**
   * Input sent during a turn joins it at its next step, or waits for the turn's end; a queued
   * input can be taken back; the session reports when an input is queued, taken or dropped.
   */
  input: { steer: 'next_step' | 'after_turn'; retract: boolean; reports: boolean }
  /** Commands and subagents keep running in the background after their call ends; jobs can stop. */
  background: { jobs: boolean; stop: boolean; subagents: boolean }
  /** The kinds whose calls Seti decides before they run (gate `before` or `request`). */
  gated: { shell: boolean; edit: boolean; mcp: boolean }
  /** The adapter reads the runtime's output itself, rather than through the vendor's library. */
  parsesOutput: boolean
}

/** A neutral decision: run the call, maybe with changed input, or refuse it with a reason. */
type NeutralDecision = { allow: true; input?: Record<string, unknown> } | { allow: false; message: string }

/** Structured questions to the user, as a question call carries them. */
export type Questions = NonNullable<ToolCall['question']>['questions']

/** How a case answers what the runtime asks while a turn waits. */
export interface NeutralHost {
  decide: (call: ToolCall, signal: AbortSignal) => Promise<NeutralDecision>
  /** The user's answers to structured questions, by question text. */
  ask: (questions: Questions, signal: AbortSignal) => Promise<Record<string, string>>
}

/** A process start a rig saw: what the adapter asked the launcher for. */
export interface SpawnRecord {
  command: string
  args: string[]
  cwd: string | undefined
  env: Record<string, string | undefined>
}

/** A fake runtime set up to play one script, and what it observed. */
export interface Rig {
  readonly launcher: Launcher
  readonly spawns: readonly SpawnRecord[]
  /** Processes the runtime started by itself, outside the launcher. */
  readonly selfStarts: readonly SpawnRecord[]
  /** Every tool call that ran, as `<tool> <args as JSON>`, in order. */
  readonly effects: readonly string[]
  /** Kills the newest process from outside, as the kernel would, with this exit code. */
  crash: (code: number) => void
}

/**
 * One adapter as the suite drives it. Besides the adapter and its profile, a target supplies the
 * members the interface does not offer yet; each is listed with the stage that removes it in the
 * R4 plan, and goes once the interface has it.
 */
export interface ConformanceTarget<S extends RuntimeShapes, Id extends string = string> {
  adapter: RuntimeAdapter<S, Id>
  profile: Profile
  /** Cases this adapter is known to fail, with the reason; they run expecting the failure. */
  gaps?: Partial<Record<string, string>>
  /** The adapter's projector, which `RuntimeAdapter` does not carry yet. */
  project: (message: unknown) => RuntimeEvent[]
  /** The host the adapter gets, answering through the neutral one. */
  host: (neutral: NeutralHost) => SessionHost<S>
  /** A fake runtime that plays the script. */
  rig: (script: Script) => Rig
}
