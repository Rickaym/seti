import type { RuntimeEvent } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import type { SessionReport } from '../adapter.js'
import { scriptedTarget } from '../scripted/target.js'
import { CASES } from './describe.js'
import { subjectOf } from './subject.js'

type Target = typeof scriptedTarget

type Change = (events: RuntimeEvent[]) => RuntimeEvent[]

/** The scripted target with every projection, live and stored, changed the same way. */
const reprojected = (change: Change): Target => ({
  ...scriptedTarget,
  adapter: {
    ...scriptedTarget.adapter,
    project: (message) => change(scriptedTarget.adapter.project(message)),
    open: async (realised, input, rewind) => {
      const session = await scriptedTarget.adapter.open(realised, input, rewind)
      return {
        ...session,
        events: mapped(session.events, (r) => (r.type === 'message' ? { ...r, events: change([...r.events]) } : r)),
      }
    },
  },
})

/** The scripted target with every report changed the same way. */
const rereported = (change: (report: SessionReport) => SessionReport): Target => ({
  ...scriptedTarget,
  adapter: {
    ...scriptedTarget.adapter,
    open: async (realised, input, rewind) => {
      const session = await scriptedTarget.adapter.open(realised, input, rewind)
      return { ...session, events: mapped(session.events, change) }
    },
  },
})

async function* mapped(
  reports: AsyncIterable<SessionReport>,
  change: (report: SessionReport) => SessionReport,
): AsyncGenerator<SessionReport> {
  for await (const report of reports) {
    yield change(report)
  }
}

let calls = 0

/** The stream's reports, ending cleanly where it failed. */
async function* swallowed(events: AsyncIterable<SessionReport>): AsyncGenerator<SessionReport> {
  try {
    yield* events
  } catch {
    return
  }
}

/** Seti's own environment, as an adapter that forgets the launcher would pass it on. */
const ownEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))

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
    'FL-2',
    reprojected((events) =>
      events.flatMap((e): RuntimeEvent[] =>
        e.type === 'vendor' && e.unreadable === true
          ? [e, { v: 1, thread: e.thread, type: 'message', id: 'misread', role: 'user', text: 'not a message' }]
          : [e],
      ),
    ),
  ],
  ['RP-1', rereported((r) => (r.type === 'message' ? { ...r, delivered: [] } : r))],
  ['RP-3', rereported((r) => (r.type === 'input' ? { ...r, state: 'other' } : r))],
  ['SA-1', reprojected((events) => events.map((e) => ({ ...e, thread: '' })))],
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
          ...(await scriptedTarget.adapter.open(realised, input, null)),
          close: () => undefined,
        }),
      },
    },
  ],
  [
    'FL-1',
    {
      ...scriptedTarget,
      adapter: {
        ...scriptedTarget.adapter,
        open: async (realised, input, rewind) => {
          const session = await scriptedTarget.adapter.open(realised, input, rewind)
          return { ...session, events: swallowed(session.events) }
        },
      },
    },
  ],
  [
    'LN-2',
    {
      ...scriptedTarget,
      adapter: {
        ...scriptedTarget.adapter,
        realise: async (spec, launcher, host, abortController) =>
          scriptedTarget.adapter.realise(
            spec,
            { ...launcher, env: { ...ownEnv(), ...launcher.env } },
            host,
            abortController,
          ),
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
