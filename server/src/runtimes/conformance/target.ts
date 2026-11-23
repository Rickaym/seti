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
  }
  usage: { tokens: boolean; costUsd: 'reported' | 'priced' | 'none' }
}

/** A neutral decision: run the call, maybe with changed input, or refuse it with a reason. */
type NeutralDecision = { allow: true; input?: Record<string, unknown> } | { allow: false; message: string }

/** How a case answers what the runtime asks while a turn waits. */
export interface NeutralHost {
  decide: (call: ToolCall, signal: AbortSignal) => Promise<NeutralDecision>
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
  /** Every tool call that ran, as `<tool> <args as JSON>`, in order. */
  readonly effects: readonly string[]
}

/** An input as the suite sends it; the id is the prompt row's id in Seti. */
export interface SuiteInput {
  id: string
  text: string
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
  project: (message: S['message']) => RuntimeEvent[]
  /** What a session starts from, given the realised spec and the inputs Seti will send. */
  start: (realised: S['realised'], inputs: AsyncIterable<SuiteInput>) => S['start']
  /** The host the adapter gets, answering through the neutral one. */
  host: (neutral: NeutralHost) => SessionHost<S>
  /** A fake runtime that plays the script. */
  rig: (script: Script) => Rig
}
