import { accountStatusSchema, prListSchema, pullRequestsSchema, taskListSchema } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readResponse } from '@/api'

const pr = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  repo_id: 'r1',
  repo_slug: 'Octocat/seti',
  number: 7,
  title: `PR ${key}`,
  url: `https://github.com/Octocat/seti/pull/${key}`,
  draft: false,
  author: 'octocat',
  head_ref: 'feat',
  base_ref: 'main',
  head_oid: 'abc',
  updated_at: '2026-10-02T12:00:00Z',
  review_decision: null,
  mergeable: 'mergeable',
  labels: [],
  ci: 'success',
  checks: [],
  unresolved_threads: 0,
  preview: { state: 'none', url: null, commit: null, stale: false },
  preview_host: null,
  tasks: [],
  related: [],
  ...extra,
})

const list = (prs: unknown[]) => ({
  viewer: 'octocat',
  scope: 'all',
  previews_on: true,
  repos: [{ repo_id: 'r1', slug: 'Octocat/seti', error: null, previews: false, prs }],
})

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Agent ${id}`,
  repo_id: null,
  repo_slug: null,
  repos: [],
  dirs: [],
  cwd: '/work',
  worktree: false,
  sandbox: true,
  profile_id: 'default',
  pr_urls: [],
  input_mode: 'wake',
  session_id: null,
  source_session_id: null,
  status: 'idle',
  permission_mode: null,
  model: null,
  cost_usd: 0,
  outward_count: 0,
  last_error: null,
  created_at: '2026-10-02T12:00:00Z',
  updated_at: '2026-10-02T12:00:00Z',
  archived_at: null,
  pinned: false,
  setup: null,
  warm_caches: [],
  running_subtasks: [],
  subtask_counts: { running: 0, completed: 0, failed: 0, stopped: 0, unknown: 0 },
  todos: [],
  pr_states: { by_url: {}, any_merged: false },
  ...extra,
})

const warn = () => vi.spyOn(console, 'warn').mockImplementation(() => undefined)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readResponse', () => {
  it('passes a well-formed PR list through untouched and quietly', () => {
    const spy = warn()
    const body = list([pr('a')])
    expect(readResponse('/prs?scope=all', prListSchema, body)).toEqual(body)
    expect(spy).not.toHaveBeenCalled()
  })

  it('defaults a PR preview that is null instead of failing the list', () => {
    const spy = warn()
    const parsed = readResponse('/prs?scope=mine', prListSchema, list([pr('a', { preview: null }), pr('b')]))
    expect(parsed.repos[0]?.prs.map((p) => p.preview)).toEqual([
      { state: 'none', url: null, commit: null, stale: false },
      { state: 'none', url: null, commit: null, stale: false },
    ])
    expect(spy).toHaveBeenCalledOnce()
    expect(String(spy.mock.calls[0]?.[0])).toMatch(/^Seti repaired a malformed response from \/prs: preview/)
  })

  it('reads a missing or malformed unresolved thread count as zero', () => {
    warn()
    const parsed = readResponse('/prs/lookup', pullRequestsSchema, [
      pr('a', { unresolved_threads: undefined }),
      pr('b', { unresolved_threads: -2 }),
      pr('c', { unresolved_threads: 4 }),
    ])
    expect(parsed.map((p) => p.unresolved_threads)).toEqual([0, 0, 4])
  })

  it('drops a PR too broken to show and keeps the rest', () => {
    warn()
    const parsed = readResponse('/prs?scope=all', prListSchema, list([{ key: 'x' }, pr('b')]))
    expect(parsed.repos[0]?.prs.map((p) => p.key)).toEqual(['b'])
  })

  it('logs the same repair once across polls', () => {
    const spy = warn()
    const body = [pr('a', { draft: 'yes' })]
    const [first] = readResponse('/prs/lookup', pullRequestsSchema, body)
    readResponse('/prs/lookup', pullRequestsSchema, body)
    expect(first?.draft).toBe(false)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('reads an unknown status as idle and drops an agent without an id', () => {
    warn()
    const parsed = readResponse('/tasks', taskListSchema, [
      task('a', {
        status: 'paused',
        pr_states: { by_url: {} },
        running_subtasks: [{ junk: true }],
        subtask_counts: { running: -1, completed: 3 },
      }),
      { title: 'no id' },
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      id: 'a',
      status: 'idle',
      pr_states: { by_url: {}, any_merged: false },
      running_subtasks: [],
      subtask_counts: { running: 0, completed: 3, failed: 0, stopped: 0, unknown: 0 },
    })
  })

  it('keeps the account readable when its usage windows are malformed', () => {
    warn()
    const parsed = readResponse('/account', accountStatusSchema, {
      account: null,
      health: 'ok',
      usage: { source: 'usage_api', observed_at: 'x', windows: [{ key: 'five_hour', utilization: '90%' }, 3] },
      usage_note: null,
      rate_limit_event: null,
      task_error: null,
      fetched_at: '2026-10-02T12:00:00Z',
    })
    expect(parsed.health.state).toBe('error')
    expect(parsed.usage?.windows).toEqual([{ key: 'five_hour', label: '', utilization: null, resets_at: null }])
  })

  it('fails with the endpoint named when the outer shape is wrong', () => {
    expect(() => readResponse('/tasks', taskListSchema, { tasks: [] })).not.toThrow()
    expect(() => readResponse('/prs?scope=all', prListSchema, 'oops')).toThrow(/^Unexpected response from \/prs: /)
  })
})
