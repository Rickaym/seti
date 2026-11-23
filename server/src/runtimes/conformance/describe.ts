import { describe, expect, it } from 'vitest'
import type { RuntimeShapes } from '../adapter.js'
import type { Case } from './case.js'
import { AGENTS } from './cases-agents.js'
import { EVENTS } from './cases-events.js'
import { FAILURES } from './cases-failures.js'
import { INPUT } from './cases-input.js'
import { INTERRUPT } from './cases-interrupt.js'
import { LAUNCH } from './cases-launch.js'
import { LIFECYCLE } from './cases-lifecycle.js'
import { PERMISSIONS } from './cases-permissions.js'
import { QUESTIONS } from './cases-questions.js'
import { TOOLS } from './cases-tools.js'
import { subjectOf } from './subject.js'
import type { ConformanceTarget } from './target.js'

/** Every case, in the order of the R4 plan. */
export const CASES: readonly Case[] = [
  ...LIFECYCLE,
  ...INTERRUPT,
  ...INPUT,
  ...EVENTS,
  ...TOOLS,
  ...PERMISSIONS,
  ...QUESTIONS,
  ...AGENTS,
  ...LAUNCH,
  ...FAILURES,
]

/**
 * Registers the conformance suite for one adapter: a test per case that applies, a skipped test
 * with the reason for each that does not, and a test expected to fail for each known gap.
 */
export function describeAdapter<S extends RuntimeShapes, Id extends string>(target: ConformanceTarget<S, Id>): void {
  const subject = subjectOf(target)
  describe(`${target.adapter.id} adapter conformance`, () => {
    for (const each of CASES) {
      const title = `${each.id}: ${each.title} [${each.proves}]`
      const skip = each.skip?.(target.profile, target.adapter.capabilities) ?? null
      const gap = target.gaps?.[each.id]
      const passes = async () => {
        await expect(each.run(subject)).resolves.toBeUndefined()
      }
      if (gap === undefined) {
        it.runIf(skip === null)(skip === null ? title : `${title} (not declared: ${skip})`, passes)
      } else {
        it.fails(`${title} (known gap: ${gap})`, passes)
      }
    }
  })
}
