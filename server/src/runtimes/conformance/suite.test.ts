import type { RuntimeEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { scriptedTarget } from '../scripted/target.js'
import { CASES } from './describe.js'
import { subjectOf } from './subject.js'

type Target = typeof scriptedTarget

const reprojected = (change: (events: RuntimeEvent[]) => RuntimeEvent[]): Target => ({
  ...scriptedTarget,
  project: (message) => change(scriptedTarget.project(message)),
})

let calls = 0

/** Adapters that are each wrong in one way, by the case that must catch it. */
const BROKEN: [string, Target][] = [
  ['LC-2', reprojected((events) => events.map((e) => (e.type === 'turn.ended' ? { ...e, status: 'error' } : e)))],
  [
    'EV-5',
    reprojected((events) =>
      events.map((e): RuntimeEvent =>
        e.type === 'vendor' ? { v: 1, thread: e.thread, type: 'vendor', name: e.name } : e,
      ),
    ),
  ],
  [
    'EV-7',
    reprojected((events) => {
      calls += 1
      return events.map((e) => (e.type === 'message' ? { ...e, id: `${e.id}-${String(calls)}` } : e))
    }),
  ],
  [
    'LC-4',
    {
      ...scriptedTarget,
      adapter: {
        ...scriptedTarget.adapter,
        open: async (realised, input) => ({
          ...(await scriptedTarget.adapter.open(realised, input)),
          close: () => undefined,
        }),
      },
    },
  ],
]

describe('the suite fails an adapter that breaks its contract', () => {
  it.each(BROKEN)('%s catches it', async (id, target) => {
    const found = CASES.find((each) => each.id === id)
    expect(found).toBeDefined()
    await expect(found?.run(subjectOf(target))).rejects.toThrow()
  })
})
