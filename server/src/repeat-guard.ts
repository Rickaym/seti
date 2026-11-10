import { createHash } from 'node:crypto'

/** Identical results in a row after which the same call again asks the user first. */
const REPEAT_RESULTS = 2

/** Output fields that change on every run, such as timings and temporary file paths. */
const VOLATILE = new Set([
  'durationMs',
  'duration_ms',
  'totalDurationMs',
  'durationSeconds',
  'rawOutputPath',
  'persistedOutputPath',
])

/** Input fields that only describe a call, which the agent rewords without changing what runs. */
const COSMETIC: Readonly<Record<string, readonly string[]>> = { Bash: ['description'] }

const byKey = ([a]: [string, unknown], [b]: [string, unknown]) => a.localeCompare(b, 'en')

/** The value with sorted keys and without the fields in `drop`, at every depth. */
function stable(value: unknown, drop: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stable(item, drop))
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  const kept = Object.entries(value).filter(([key]) => !drop.has(key))
  return Object.fromEntries(kept.toSorted(byKey).map(([key, item]) => [key, stable(item, drop)]))
}

const digest = (value: unknown) =>
  createHash('sha256')
    .update(value === undefined ? 'undefined' : JSON.stringify(value))
    .digest('base64url')

/** A stable hash of the call, so Seti keeps no copy of its input. */
export function callKey(tool: string, input: unknown): string {
  const cosmetic = new Set(COSMETIC[tool] ?? [])
  const top =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.fromEntries(Object.entries(input).filter(([key]) => !cosmetic.has(key)))
      : input
  return digest([tool, stable(top, new Set())])
}

/** A stable hash of what the call returned, without the fields that change on every run. */
export const resultKey = (result: unknown): string => digest(stable(result, VOLATILE))

interface Run {
  call: string
  result: string
  count: number
}

/**
 * Runs of the same call with the same result, per thread of one session: '' for the agent itself,
 * else the subagent's id, so a subagent's calls never count toward its parent's.
 */
export class RepeatTracker {
  private readonly runs = new Map<string, Run>()
  /** Calls the user said to stop asking about for the rest of the session. */
  private readonly lifted = new Set<string>()

  ran(thread: string, call: string, result: string): void {
    const run = this.runs.get(thread)
    const same = run?.call === call && run.result === result
    this.runs.set(thread, same ? { ...run, count: run.count + 1 } : { call, result, count: 1 })
  }

  /** How many identical results the call would follow, once that reaches the limit; else 0. */
  repeats(thread: string, call: string): number {
    const run = this.runs.get(thread)
    if (run?.call !== call || this.lifted.has(call) || run.count < REPEAT_RESULTS) {
      return 0
    }
    return run.count
  }

  /** Starts the thread's count again, as after an interrupt or the user's Allow. */
  reset(thread: string): void {
    this.runs.delete(thread)
  }

  /** Starts every thread's count again, as a message from the user does. */
  resetAll(): void {
    this.runs.clear()
  }

  /** The user allowed the call; with `always` Seti stops asking about it for the session. */
  allowed(thread: string, call: string, always: boolean): void {
    this.reset(thread)
    if (always) {
      this.lifted.add(call)
    }
  }
}

/** The reason line of a repeat, which names the tool and how many identical results came back. */
export function repeatReason(tool: string, results: number): string {
  const what = tool === 'Bash' ? 'Bash command' : `${tool} call`
  return `Runs the same ${what} again after ${String(results)} identical results`
}
