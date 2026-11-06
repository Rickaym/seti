import { DEFAULT_TIERS, listedSubtasks, prStates, type TaskListEntry, type TaskStatus } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { failureId, pendingFailures } from './failure-toasts'
import { turnEvents, wantedEvents, type TurnEvent } from './turn-events'

interface Extra {
  muted?: boolean
  created?: string
  running?: number
}

function task(id: string, status: TaskStatus, updated: string, extra: Extra = {}): TaskListEntry {
  return {
    id,
    title: id,
    status,
    updated_at: updated,
    created_at: extra.created ?? '2026-10-01T00:00:00Z',
    pr_urls: [],
    pr_states: prStates({}),
    subtask_counts: { ...listedSubtasks([]).subtask_counts, running: extra.running ?? 0 },
    notifications_muted: extra.muted ?? false,
  } as unknown as TaskListEntry
}

const SINCE = '2026-10-02T12:00:00.000Z'
const LOOKED = Date.parse('2026-10-02T12:01:30Z')
const kinds = (events: readonly TurnEvent[]) => events.map((event) => `${event.task.id}:${event.kind}`)

describe('turnEvents', () => {
  const first = [
    task('worker', 'running', '2026-10-02T12:01:00Z'),
    task('quick', 'idle', '2026-10-02T12:01:00Z'),
    task('crash', 'running', '2026-10-02T12:01:00Z'),
    task('old', 'error', '2026-10-02T11:00:00Z'),
  ]

  it('takes the first list as the baseline', () => {
    expect(turnEvents(null, first, SINCE, LOOKED).events).toEqual([])
  })

  it('reports finished turns and needs-you states once, including a turn that ran between polls', () => {
    const { seen } = turnEvents(null, first, SINCE, LOOKED)
    const second = [
      task('worker', 'idle', '2026-10-02T12:02:00Z'),
      task('quick', 'idle', '2026-10-02T12:02:30Z'),
      task('crash', 'error', '2026-10-02T12:02:00Z'),
      task('old', 'error', '2026-10-02T11:00:00Z'),
      task('new', 'idle', '2026-10-02T12:02:00Z', { created: '2026-10-02T12:01:45Z' }),
      task('restored', 'idle', '2026-10-02T12:00:30Z'),
    ]
    const next = turnEvents(seen, second, SINCE, LOOKED + 5000)
    expect(kinds(next.events)).toEqual(['worker:finished', 'quick:finished', 'crash:needs_you', 'new:finished'])
    expect(turnEvents(next.seen, second, SINCE).events).toEqual([])
  })

  it('leaves out turns that stopped, still run subagents, or changed before the baseline time', () => {
    const before = [task('a', 'running', '2026-10-02T11:00:00Z'), task('b', 'running', '2026-10-02T12:01:00Z')]
    const { seen } = turnEvents(null, [...before, task('c', 'running', '2026-10-02T12:01:00Z')], SINCE, LOOKED)
    const after = [
      task('a', 'idle', '2026-10-02T11:30:00Z'),
      task('b', 'stopped', '2026-10-02T12:03:00Z'),
      task('c', 'idle', '2026-10-02T12:03:00Z', { running: 1 }),
    ]
    expect(turnEvents(seen, after, SINCE, LOOKED).events).toEqual([])
  })
})

describe('wantedEvents', () => {
  const events: TurnEvent[] = [
    { task: task('shown', 'idle', SINCE), kind: 'finished' },
    { task: task('muted', 'idle', SINCE, { muted: true }), kind: 'finished' },
    { task: task('done', 'idle', SINCE), kind: 'finished' },
    { task: task('failed', 'error', SINCE), kind: 'needs_you' },
  ]

  it('skips agents on screen, muted agents, agents the EA reports on and quiet tiers', () => {
    const shown = new Set(['shown'])
    expect(kinds(wantedEvents(events, DEFAULT_TIERS, shown))).toEqual(['done:finished', 'failed:needs_you'])
    expect(kinds(wantedEvents(events, { ...DEFAULT_TIERS, active: 'brief' }, shown))).toEqual(['failed:needs_you'])
    expect(kinds(wantedEvents(events, DEFAULT_TIERS, shown, new Set(['done'])))).toEqual(['failed:needs_you'])
  })
})

describe('failure toasts of muted agents', () => {
  it('stay quiet', () => {
    const failed = task('muted', 'error', '2026-10-02T12:05:00Z', { muted: true })
    expect(pendingFailures([failed], { since: SINCE, dismissed: new Set(), openId: null })).toEqual([])
    expect(failureId(failed)).toBe('muted@2026-10-02T12:05:00Z')
  })
})
