import { normalizeAgentColor, type TaskDisplayStatus, type TaskListEntry } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { filterAgents, groupAgents, nestDelegates, nextUnseen, type AgentRow } from './agent-list'

function row(id: string, status: TaskDisplayStatus, extra: Partial<TaskListEntry> = {}): AgentRow {
  const task = {
    id,
    title: `Agent ${id}`,
    repos: [],
    cwd: `/work/${id}`,
    pinned: false,
    color: null,
    unseen: true,
    updated_at: '2026-10-02T12:00:00Z',
    delegated_by: null,
    ...extra,
  } as unknown as TaskListEntry
  return { task, running: 0, status }
}

const ids = (rows: readonly AgentRow[]) => rows.map((r) => r.task.id)

describe('groupAgents', () => {
  it('puts errored, interrupted and asking agents first, newest first, above pinned ones', () => {
    const rows = [
      row('pinned', 'idle', { pinned: true, updated_at: '2026-10-02T13:00:00Z' }),
      row('old-error', 'error', { updated_at: '2026-10-01T09:00:00Z' }),
      row('running', 'running'),
      row('cut-off', 'interrupted', { updated_at: '2026-10-02T11:00:00Z' }),
      row('stopped', 'stopped'),
      row('pinned-error', 'error', { pinned: true, updated_at: '2026-10-02T14:00:00Z' }),
      row('asking', 'asking', { updated_at: '2026-10-02T12:30:00Z' }),
    ]
    const { needsYou, others } = groupAgents(rows)
    expect(ids(needsYou)).toEqual(['pinned-error', 'asking', 'cut-off', 'old-error'])
    expect(ids(others)).toEqual(['pinned', 'running', 'stopped'])
  })

  it('leaves out a needs-you agent the user has opened since its turn ended', () => {
    const { needsYou, others } = groupAgents([row('seen', 'error', { unseen: false }), row('unseen', 'asking')])
    expect(ids(needsYou)).toEqual(['unseen'])
    expect(ids(others)).toEqual(['seen'])
  })
})

describe('filterAgents', () => {
  const rows = [
    row('a', 'error', { title: 'Fix the login redirect' }),
    row('b', 'idle', {
      unseen: false,
      title: 'Voicemail retry',
      repos: [{ id: 'r', slug: 'Octocat/seti', dir: '/w', worktree: false }],
      color: normalizeAgentColor('teal'),
    }),
    row('c', 'interrupted', {
      title: 'Nightly digest',
      pinned: true,
      color: normalizeAgentColor('#1a3'),
      unseen: true,
    }),
  ]

  it('matches every term against the title, repo, folder and status words', () => {
    expect(ids(filterAgents(rows, 'login'))).toEqual(['a'])
    expect(ids(filterAgents(rows, 'SETI retry'))).toEqual(['b'])
    expect(ids(filterAgents(rows, 'needs you'))).toEqual(['a', 'c'])
    expect(ids(filterAgents([row('e', 'error', { unseen: false })], 'needs you'))).toEqual([])
    expect(ids(filterAgents(rows, 'interrupted pinned'))).toEqual(['c'])
    expect(ids(filterAgents(rows, '/work/a'))).toEqual(['a'])
    expect(ids(filterAgents(rows, 'teal'))).toEqual(['b'])
    expect(ids(filterAgents(rows, '#11AA33'))).toEqual(['c'])
    expect(ids(filterAgents(rows, 'unseen'))).toEqual(['a', 'c'])
    expect(ids(filterAgents([...rows, row('d', 'asking')], 'asks you'))).toEqual(['d'])
  })

  it('keeps everything for a blank query and nothing for a miss', () => {
    expect(ids(filterAgents(rows, '  '))).toEqual(['a', 'b', 'c'])
    expect(filterAgents(rows, 'database')).toEqual([])
  })
})

describe('nestDelegates', () => {
  it('puts each helper right under its caller and names the caller', () => {
    const rows = [
      row('helper-b', 'running', { delegated_by: 'lead' }),
      row('other', 'idle'),
      row('lead', 'running'),
      row('helper-a', 'idle', { delegated_by: 'lead' }),
    ]
    const nested = nestDelegates(rows)
    expect(ids(nested)).toEqual(['other', 'lead', 'helper-b', 'helper-a'])
    expect(nested.map((r) => r.under)).toEqual([null, null, 'Agent lead', 'Agent lead'])
  })

  it('keeps a helper at the top level when its caller is not listed', () => {
    const nested = nestDelegates([row('helper', 'idle', { delegated_by: 'archived' }), row('other', 'idle')])
    expect(ids(nested)).toEqual(['helper', 'other'])
    expect(nested.map((r) => r.under)).toEqual([null, null])
  })

  it('lists every row once even when callers point at each other', () => {
    const nested = nestDelegates([row('a', 'idle', { delegated_by: 'b' }), row('b', 'idle', { delegated_by: 'a' })])
    expect(ids(nested).toSorted((a, b) => a.localeCompare(b))).toEqual(['a', 'b'])
  })
})

describe('nextUnseen', () => {
  const agent = (id: string, unseen: boolean, updated_at: string) => ({ id, unseen, updated_at })
  const tasks = [
    agent('seen', false, '2026-10-02T15:00:00Z'),
    agent('older', true, '2026-10-02T10:00:00Z'),
    agent('newer', true, '2026-10-02T12:00:00Z'),
  ]

  it('picks the most recently finished unseen agent', () => {
    expect(nextUnseen(tasks, null)).toBe('newer')
    expect(nextUnseen(tasks, 'seen')).toBe('newer')
  })

  it('skips the agent open now, and finds none when no other one is unseen', () => {
    expect(nextUnseen(tasks, 'newer')).toBe('older')
    expect(nextUnseen([agent('only', true, '2026-10-02T10:00:00Z')], 'only')).toBeNull()
    expect(nextUnseen([], null)).toBeNull()
  })
})
