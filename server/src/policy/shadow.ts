import { compareOutcomes, type ShadowClass } from './compare.js'
import type { Decision, DecisionStep, PolicyKind, PolicyMode, Verdict } from './types.js'

/** What the runtime did with a call, as its session showed it; `unobserved` when nothing did. */
export type Observed = 'allow' | 'ask' | 'deny' | 'interrupted'

/** The call's facts a shadow record keeps: never its input, only what kind of call it was. */
export interface CallFacts {
  kind: PolicyKind
  /** The tool's name, or `mcp` for any tool-server tool. */
  tool: string
  mode: PolicyMode
  sandboxed: boolean
  /** Whether Seti took longer than it should to decide. */
  slow: boolean
}

/** One compared call, as counted: no input, no command, no path, no rule text. */
export interface ShadowRecord extends CallFacts {
  verdict: Verdict
  step: DecisionStep
  /** The deciding rule's ref, or '' when no rule decided. */
  rule: string
  runtime: Observed | 'unobserved'
  result: ShadowClass | 'interrupted' | 'unobserved'
}

interface Open {
  facts?: CallFacts
  decision?: Decision
  runtime?: Observed
  /** The runtime asked while its auto mode was paused after repeated classifier blocks. */
  paused?: boolean
}

/** Claude Code's auto mode prompts after this many classifier blocks in a row, or in all. */
const BLOCKS_IN_A_ROW = 3
const BLOCKS_IN_ALL = 20

/** Calls of one session waiting for both sides, at most this many; the oldest go first. */
const OPEN_MAX = 1000

/** A call Seti's own hooks refuse or hold never reaches the runtime's rules, so is not compared. */
const setiHook = (decision: Decision) => decision.step === 'guard' || decision.verdict === 'review'

function resultOf(decision: Decision, runtime: Observed | 'unobserved', paused: boolean): ShadowRecord['result'] {
  if (paused && runtime === 'ask' && decision.verdict === 'defer') {
    return 'deferred'
  }
  if (runtime !== 'interrupted' && runtime !== 'unobserved') {
    return compareOutcomes(decision, runtime)
  }
  return setiHook(decision) ? 'seti-hook' : runtime
}

function recordOf(
  facts: CallFacts,
  decision: Decision,
  runtime: Observed | 'unobserved',
  paused = false,
): ShadowRecord {
  const result = resultOf(decision, runtime, paused)
  return { ...facts, verdict: decision.verdict, step: decision.step, rule: decision.rule ?? '', runtime, result }
}

/**
 * Pairs Seti's decision on each call of a session with what the runtime did, whichever comes
 * first, and hands each pair on once. What the runtime did first counts: an ask stays an ask
 * after the user allows the call. A deferred call the runtime asked about while its auto mode was
 * paused after repeated classifier blocks counts as deferred: the classifier's fallback asked.
 */
export class ShadowTracker {
  private readonly open = new Map<string, Open>()
  /** Calls already handed on, so a later sign of the same call opens nothing. */
  private readonly done = new Set<string>()
  private readonly emit: (record: ShadowRecord) => void
  /** Classifier blocks since a call last ran, and since the total last paused auto mode. */
  private readonly blocks = { inARow: 0, inAll: 0 }
  private paused = false

  constructor(emit: (record: ShadowRecord) => void) {
    this.emit = emit
  }

  decided(callId: string, facts: CallFacts, decision: Decision): void {
    this.update(callId, { facts, decision })
  }

  observed(callId: string, runtime: Observed): void {
    const paused = runtime === 'ask' && this.paused
    this.count(runtime)
    if (!this.done.has(callId) && this.open.get(callId)?.runtime === undefined) {
      this.update(callId, paused ? { runtime, paused } : { runtime })
    }
  }

  /** Follows auto mode's pause: a block counts, a call that ran resumes it and ends the row. */
  private count(runtime: Observed): void {
    if (runtime === 'allow') {
      this.blocks.inARow = 0
      this.paused = false
    } else if (runtime === 'deny') {
      this.blocks.inARow += 1
      this.blocks.inAll += 1
      if (this.blocks.inAll >= BLOCKS_IN_ALL) {
        this.blocks.inAll = 0
        this.paused = true
      }
      this.paused ||= this.blocks.inARow >= BLOCKS_IN_A_ROW
    }
  }

  /** Ends the session: a call Seti decided and the runtime never ran, asked or denied is unobserved. */
  close(): void {
    for (const entry of this.open.values()) {
      if (entry.facts !== undefined && entry.decision !== undefined) {
        this.emit(recordOf(entry.facts, entry.decision, 'unobserved'))
      }
    }
    this.open.clear()
    this.done.clear()
  }

  private update(callId: string, part: Open): void {
    const entry = { ...this.open.get(callId), ...part }
    if (entry.facts !== undefined && entry.decision !== undefined && entry.runtime !== undefined) {
      this.open.delete(callId)
      this.finish(callId)
      this.emit(recordOf(entry.facts, entry.decision, entry.runtime, entry.paused))
      return
    }
    this.open.set(callId, entry)
    if (this.open.size > OPEN_MAX) {
      this.open.delete(this.open.keys().next().value ?? '')
    }
  }

  private finish(callId: string): void {
    this.done.add(callId)
    if (this.done.size > OPEN_MAX) {
      this.done.delete(this.done.values().next().value ?? '')
    }
  }
}
