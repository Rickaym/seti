import type { SubtaskBrief } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  mergeBriefs,
  progressLine,
  runningBadge,
  subagentsLabel,
  subtaskCounts,
  subtaskElapsed,
  subtaskTree,
} from '@/lib/subtasks'

const brief = (id: string, extra: Partial<SubtaskBrief> = {}): SubtaskBrief => ({
  tool_use_id: id,
  tool_use_ids: [id],
  parent_tool_use_id: null,
  message_id: 1,
  sdk_task_id: null,
  description: id,
  subagent_type: 'general-purpose',
  background: true,
  status: 'completed',
  progress: null,
  usage: null,
  started_at: '2026-09-27T10:00:00.000Z',
  ended_at: '2026-09-27T10:02:05.000Z',
  summary: null,
  pr_urls: [],
  ...extra,
})

const ids = (nodes: { subtask: SubtaskBrief; depth: number }[]) =>
  nodes.map((n) => `${n.subtask.tool_use_id}@${String(n.depth)}`)

describe('subtaskTree', () => {
  it('puts nested subtasks right after the one that started them', () => {
    const list = [
      brief('a'),
      brief('b'),
      brief('a1', { parent_tool_use_id: 'a' }),
      brief('a1x', { parent_tool_use_id: 'a1' }),
    ]
    expect(ids(subtaskTree(list))).toEqual(['a@0', 'a1@1', 'a1x@2', 'b@0'])
  })

  it('shows a subtask whose parent is unknown at the top level', () => {
    expect(ids(subtaskTree([brief('orphan', { parent_tool_use_id: 'gone' })]))).toEqual(['orphan@0'])
  })

  it('puts running subtasks and parents of running ones before the rest, keeping start order', () => {
    const list = [
      brief('done', { status: 'completed' }),
      brief('parent', { status: 'completed' }),
      brief('child-done', { status: 'completed', parent_tool_use_id: 'parent' }),
      brief('child-live', { status: 'running', parent_tool_use_id: 'parent' }),
      brief('live', { status: 'running' }),
      brief('failed', { status: 'failed' }),
    ]
    expect(ids(subtaskTree(list))).toEqual(['parent@0', 'child-live@1', 'child-done@1', 'live@0', 'done@0', 'failed@0'])
  })
})

describe('mergeBriefs', () => {
  it('reuses unchanged objects and the list itself when nothing changed', () => {
    const prev = [brief('a'), brief('b')]
    expect(mergeBriefs(prev, [brief('a'), brief('b')])).toBe(prev)
    const next = mergeBriefs(prev, [brief('a'), brief('b', { status: 'failed' })])
    expect(next[0]).toBe(prev[0])
    expect(next[1]?.status).toBe('failed')
  })
})

describe('progress and elapsed', () => {
  it('describes a running subtask by its last tool and totals', () => {
    const running = brief('r', {
      status: 'running',
      ended_at: null,
      progress: { description: 'r', last_tool: 'Bash', summary: null },
      usage: { total_tokens: 48_200, tool_uses: 12, duration_ms: 1 },
    })
    expect(progressLine(running)).toBe('last: Bash | 12 tool uses | 48.2k tokens')
    expect(subtaskElapsed(running, Date.parse('2026-09-27T10:01:05.000Z'))).toBe('1m 05s')
  })

  it('shows the summary and run time of an ended subtask', () => {
    const done = brief('d', { summary: 'All green.' })
    expect(progressLine(done)).toBe('All green.')
    expect(subtaskElapsed(done, 0)).toBe('2m 05s')
    expect(subtaskElapsed(brief('u', { status: 'unknown', ended_at: null }), 0)).toBeNull()
  })
})

describe('subagentsLabel', () => {
  it('names the total, then each status but done, most pressing first', () => {
    const list = [
      brief('a', { status: 'completed' }),
      brief('b', { status: 'failed' }),
      brief('c', { status: 'running' }),
      brief('d', { status: 'completed' }),
    ]
    expect(subagentsLabel(list)).toBe('4 subagents, 1 running, 1 failed')
    expect(subtaskCounts(list)).toEqual([
      { status: 'running', count: 1 },
      { status: 'failed', count: 1 },
      { status: 'completed', count: 2 },
    ])
  })

  it('says subagent for one and leaves done out', () => {
    expect(subagentsLabel([brief('a')])).toBe('1 subagent')
    expect(subagentsLabel([brief('a', { status: 'unknown' })])).toBe('1 subagent, 1 no report')
  })
})

describe('runningBadge', () => {
  it('counts only the subagents that run now', () => {
    const finished = Array.from({ length: 150 }, (_, i) => brief(`done-${String(i)}`))
    const list = [...finished, brief('r1', { status: 'running' }), brief('f', { status: 'failed' })]
    expect(runningBadge([...list, brief('r2', { status: 'running' })])).toBe('2')
    expect(runningBadge(list)).toBe('1')
  })

  it('shows no number while none runs', () => {
    expect(runningBadge([brief('a'), brief('b', { status: 'stopped' }), brief('c', { status: 'unknown' })])).toBeNull()
    expect(runningBadge([])).toBeNull()
  })
})
