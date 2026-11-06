import type { HomeSummary, SubtaskBrief, TaskListEntry } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { buildGraph, DEFAULT_FILTERS } from './graph-model'

const subtask = (id: string, parent: string | null): SubtaskBrief => ({
  tool_use_id: id,
  tool_use_ids: [id],
  parent_tool_use_id: parent,
  message_id: 1,
  sdk_task_id: null,
  description: `look at ${id}`,
  subagent_type: 'Explore',
  background: false,
  status: 'running',
  progress: null,
  usage: null,
  started_at: '2026-10-01T00:00:00.000Z',
  ended_at: null,
  summary: null,
  pr_urls: [],
})

const task = (id: string, extra: Partial<TaskListEntry> = {}) =>
  ({
    id,
    title: `Agent ${id}`,
    color: null,
    status: 'idle',
    asking: false,
    blocked: null,
    pr_urls: [],
    repos: [{ id: 'r1', slug: 'acme/web', dir: '/srv/web', worktree: false }],
    running_subtasks: [],
    subtask_counts: { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 },
    pr_states: { by_url: {}, any_merged: false },
    ...extra,
  }) as unknown as TaskListEntry

const tally = { merged_7d: 0, merged_30d: 0, cost_7d_usd: 0, run_ms_7d: 0, run_ms_30d: 0, turns_7d: 0 }

const summary: HomeSummary = {
  zone: 'UTC',
  totals: { ...tally, turns_30d: 0, cost_30d_usd: 0 },
  streak_days: 0,
  days: [],
  agents: [
    {
      task_id: 'a',
      ...tally,
      turns_30d: 40,
      cost_30d_usd: 1,
      mcp: [{ server: 'github', calls: 3 }],
    },
    { task_id: 'b', ...tally, turns_30d: 10, cost_30d_usd: 9, mcp: [] },
  ],
  recent: [],
  live: [
    { task_id: 'b', tool: 'Bash', server: null, subagent: 's2', since: '' },
    { task_id: 'b', tool: 'mcp__linear__search', server: 'linear', subagent: null, since: '' },
  ],
}

const b = task('b', { running_subtasks: [subtask('s1', null), subtask('s2', 's1'), subtask('s3', 'gone')] })

describe('buildGraph', () => {
  it('links agents to shared repos, MCP servers, nested subagents and live calls', () => {
    const graph = buildGraph({ tasks: [task('a'), b], archived: [], summary, filters: DEFAULT_FILTERS })
    const edges = graph.edges.map((edge) => `${edge.source}>${edge.target}${edge.live ? ' live' : ''}`)
    expect(graph.nodes.filter((node) => node.kind === 'repo')).toHaveLength(1)
    expect(edges).toEqual(
      expect.arrayContaining([
        'agent:a>repo:r1',
        'agent:b>repo:r1',
        'agent:a>mcp:github',
        'agent:b>sub:b:s1 live',
        'sub:b:s1>sub:b:s2 live',
        'agent:b>sub:b:s3 live',
        'sub:b:s2>tool:sub:b:s2:Bash live',
        'agent:b>mcp:linear live',
      ]),
    )
  })

  it('sizes agents by turns or by cost, and hides what the filters turn off', () => {
    const turns = buildGraph({ tasks: [task('a'), b], archived: [], summary, filters: DEFAULT_FILTERS })
    const cost = buildGraph({
      tasks: [task('a'), b],
      archived: [],
      summary,
      filters: { ...DEFAULT_FILTERS, cost: true, repos: false, tools: false, subagents: false },
    })
    const radius = (graph: typeof turns, id: string) => graph.nodes.find((node) => node.id === id)?.radius ?? 0
    expect(radius(turns, 'agent:a')).toBeGreaterThan(radius(turns, 'agent:b'))
    expect(radius(cost, 'agent:b')).toBeGreaterThan(radius(cost, 'agent:a'))
    expect(cost.nodes.map((node) => node.kind)).toEqual(['agent', 'agent'])
    expect(cost.edges).toEqual([])
  })
})
