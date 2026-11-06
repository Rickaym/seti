import { listedSubtasks, prStates, type TaskListEntry, type TaskStatus } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { failureId, pendingFailures } from './failure-toasts'

function task(id: string, status: TaskStatus, updated: string): TaskListEntry {
  return {
    id,
    status,
    updated_at: updated,
    pr_urls: [],
    pr_states: prStates({}),
    ...listedSubtasks([]),
  } as unknown as TaskListEntry
}

const SINCE = '2026-10-02T12:00:00.000Z'

describe('pendingFailures', () => {
  const tasks = [
    task('before', 'error', '2026-10-02T11:00:00Z'),
    task('error', 'error', '2026-10-02T12:05:00Z'),
    task('cut-off', 'interrupted', '2026-10-02T12:10:00Z'),
    task('idle', 'idle', '2026-10-02T12:20:00Z'),
    task('stopped', 'stopped', '2026-10-02T12:30:00Z'),
    { ...task('asking', 'idle', '2026-10-02T12:40:00Z'), asking: true },
  ]

  it('raises failures since the baseline, newest first, and no agent that only asks a question', () => {
    const pending = pendingFailures(tasks, { since: SINCE, dismissed: new Set(), openId: null })
    expect(pending.map((t) => t.id)).toEqual(['cut-off', 'error'])
  })

  it('skips dismissed failures and the agent open now', () => {
    const dismissed = new Set([failureId(task('error', 'error', '2026-10-02T12:05:00Z'))])
    expect(pendingFailures(tasks, { since: SINCE, dismissed, openId: 'cut-off' })).toEqual([])
  })

  it('raises the same agent again when it fails again later', () => {
    const dismissed = new Set([failureId(task('error', 'error', '2026-10-02T12:05:00Z'))])
    const again = [task('error', 'error', '2026-10-02T13:00:00Z')]
    expect(pendingFailures(again, { since: SINCE, dismissed, openId: null })).toHaveLength(1)
  })
})
