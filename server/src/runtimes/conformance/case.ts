import type { EventOf, RuntimeEvent } from '@seti/shared'
import { expect } from 'vitest'
import type { RuntimeAdapter, RuntimeShapes } from '../adapter.js'
import { isTurnEnd, type RunView } from './run.js'
import type { Subject } from './subject.js'
import type { Profile } from './target.js'

/** What an adapter's own `Capabilities` declare. */
type Declared = RuntimeAdapter<RuntimeShapes>['capabilities']

/** One conformance case: what it proves, when it applies, and how it runs against a subject. */
export interface Case {
  id: string
  title: string
  /** The protocol requirement or interface member the case proves. */
  proves: string
  /** Why the case does not apply to a runtime with this profile; absent or null when it does. */
  skip?: (profile: Profile, declared: Declared) => string | null
  /** The case drives the runtime's one-shot, which a target may not supply yet. */
  needsOneShot?: true
  run: (subject: Subject) => Promise<void>
}

/** The ends of the agent's own turns, in order. */
const turnEnds = (run: RunView): EventOf<'turn.ended'>[] => run.events.filter(isTurnEnd)

/** Waits for the agent's turn number `n` (from 1) to end and returns its end. */
export async function turnEnd(run: RunView, n: number): Promise<EventOf<'turn.ended'>> {
  await run.until(() => turnEnds(run).length >= n, `turn ${String(n)}`)
  const end = turnEnds(run)[n - 1]
  if (end === undefined) {
    throw new Error(`turn ${String(n)} has no end`)
  }
  return end
}

/** The events of one type, in order. */
export const ofType = <T extends RuntimeEvent['type']>(run: RunView, type: T): EventOf<T>[] =>
  run.events.filter((event): event is EventOf<T> => event.type === type)

/** Closes the session and checks its events end within the bound, cleanly or with an Error. */
export async function closed(run: RunView): Promise<void> {
  run.close()
  const outcome = await run.settled()
  expect(outcome === null || outcome instanceof Error).toBe(true)
}
