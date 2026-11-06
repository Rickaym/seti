import type { InputSubtask, PrInput } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import type { WatchedPr } from './github.js'
import type { PrSnapshot } from './pr-events.js'
import { createPrInputPoller, type PrInputDeps } from './pr-inputs.js'
import type { HeldInput } from './store/pr-held.js'

await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-pr-inputs-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
})

const WEB = 'https://github.com/acme/web/pull/1'
const API = 'https://github.com/acme/api/pull/2'

const watched = (url: string, overrides: Partial<WatchedPr> = {}): WatchedPr => ({
  url,
  subject: url.replace('https://github.com/', '').replace('/pull/', '#'),
  state: 'open',
  closed_at: null,
  conflicting: false,
  head_oid: 'abc1234',
  ci: 'pending',
  checks: [],
  reviews: [],
  comments: [],
  ...overrides,
})

/** `links` names each listener as `task` or `task>agent call` for a PR linked to a subagent. */
function harness(
  prs: Map<string, WatchedPr | null>,
  links: Record<string, string[]>,
  subagents: Record<string, InputSubtask> = {},
) {
  const snapshots = new Map<string, PrSnapshot>()
  const delivered: { taskId: string; inputs: readonly PrInput[] }[] = []
  const errors: unknown[] = []
  const deps: PrInputDeps = {
    watched: async () => Promise.resolve(Object.keys(links)),
    listeners: async (url) =>
      Promise.resolve(
        (links[url] ?? []).map((entry) => {
          const [taskId = '', call] = entry.split('>')
          return { task_id: taskId, tool_use_id: call ?? null }
        }),
      ),
    subtask: async (_taskId, toolUseId) => Promise.resolve(subagents[toolUseId] ?? null),
    snapshot: async (url) => Promise.resolve(snapshots.get(url)),
    save: async (url, snapshot) => {
      snapshots.set(url, snapshot)
      return Promise.resolve()
    },
    fetch: vi.fn(async () => Promise.resolve(prs)),
    viewer: async () => Promise.resolve('octocat'),
    deliver: async (taskId, inputs) => {
      delivered.push({ taskId, inputs })
      return Promise.resolve()
    },
    onError: (error) => errors.push(error),
  }
  return { deps, poller: createPrInputPoller(deps), snapshots, delivered, errors }
}

describe('PR input poller', () => {
  it('sets a baseline first, then hands each linked task the changes of all its PRs at once', async () => {
    const prs = new Map<string, WatchedPr | null>([
      [WEB, watched(WEB)],
      [API, watched(API)],
    ])
    const { poller, delivered, snapshots } = harness(prs, { [WEB]: ['t1', 't2'], [API]: ['t1'] })
    await poller.poll()
    expect(delivered).toEqual([])
    expect([...snapshots.keys()]).toEqual([WEB, API])

    prs.set(WEB, watched(WEB, { ci: 'failure' }))
    prs.set(API, watched(API, { state: 'merged' }))
    await poller.poll()
    expect(delivered.map((d) => [d.taskId, d.inputs.map((input) => input.kind)])).toEqual([
      ['t1', ['ci_failed', 'merged']],
      ['t2', ['ci_failed']],
    ])
  })

  it('skips PRs gh cannot read and does nothing without watched PRs', async () => {
    const { poller, deps, delivered, snapshots } = harness(new Map([[WEB, null]]), { [WEB]: ['t1'] })
    await poller.poll()
    expect(snapshots.size).toBe(0)
    expect(delivered).toEqual([])
    const idle = harness(new Map(), {})
    await idle.poller.poll()
    expect(idle.deps.fetch).not.toHaveBeenCalled()
    expect(deps.fetch).toHaveBeenCalledWith([WEB])
  })

  it('reports gh failures and delivery failures without stopping the other tasks', async () => {
    const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
    const h = harness(prs, { [WEB]: ['t1', 't2'] })
    await h.poller.poll()
    prs.set(WEB, watched(WEB, { conflicting: true }))
    const seen: string[] = []
    h.deps.deliver = async (taskId) => {
      seen.push(taskId)
      if (taskId === 't1') {
        return Promise.reject(new Error('turn failed'))
      }
      return Promise.resolve()
    }
    await createPrInputPoller(h.deps).poll()
    expect(seen).toEqual(['t1', 't2'])
    expect(h.errors).toEqual([new Error('turn failed')])

    h.deps.fetch = async () => Promise.reject(new Error('gh: not logged in'))
    await createPrInputPoller(h.deps).poll()
    expect(h.errors.at(-1)).toEqual(new Error('gh: not logged in'))
  })

  it('names the subagent a PR is linked to on its updates, per task', async () => {
    const running: InputSubtask = { tool_use_id: 'toolu_a', description: 'Fix login', agent_id: 'a1', running: true }
    const finished: InputSubtask = { ...running, tool_use_id: 'toolu_b', description: 'Docs', running: false }
    const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
    const h = harness(
      prs,
      { [WEB]: ['t1>toolu_a', 't2>toolu_b', 't3', 't4>toolu_gone'] },
      {
        toolu_a: running,
        toolu_b: finished,
      },
    )
    await h.poller.poll()
    prs.set(WEB, watched(WEB, { ci: 'failure' }))
    await h.poller.poll()
    expect(h.delivered.map((d) => [d.taskId, d.inputs.map((input) => input.subtask ?? null)])).toEqual([
      ['t1', [running]],
      ['t2', [finished]],
      ['t3', [null]],
      ['t4', [null]],
    ])
    expect(h.delivered.every((d) => d.inputs[0]?.kind === 'ci_failed')).toBe(true)
  })

  it('hands over the last update of a PR that ended before dropping its links', async () => {
    const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
    const h = harness(prs, { [WEB]: ['t1'] })
    const order: string[] = []
    h.deps.deliver = async (taskId, inputs) => {
      order.push(`${taskId}:${inputs.map((input) => input.kind).join(',')}`)
      return Promise.resolve()
    }
    h.deps.unlinkEnded = async () => {
      order.push('unlink')
      return Promise.resolve()
    }
    const poller = createPrInputPoller(h.deps)
    await poller.poll()
    prs.set(WEB, watched(WEB, { state: 'merged' }))
    await poller.poll()
    expect(order).toEqual(['unlink', 't1:merged', 'unlink'])
  })

  it('drops links to PRs that ended while Seti was down as it starts', async () => {
    const h = harness(new Map(), {})
    let swept = 0
    h.deps.unlinkEnded = async () => {
      swept += 1
      return Promise.resolve()
    }
    const poller = createPrInputPoller(h.deps)
    poller.start(60_000)
    poller.start(60_000)
    poller.stop()
    await Promise.resolve()
    expect(swept).toBe(1)
  })

  it('asks which new comments the agents posted, and passes on the rest as one update', async () => {
    const at = '2026-10-07T10:00:00Z'
    const comment = (id: string, login: string) => ({
      id,
      body: `Comment ${id}`,
      url: `${WEB}#issuecomment-${id}`,
      created_at: at,
      author: { login, bot: false },
    })
    const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
    const h = harness(prs, { [WEB]: ['t1'] })
    const asked: string[][] = []
    h.deps.agentPosts = async (url, posts, viewer) => {
      asked.push([url, viewer, ...posts.map((post) => post.id)])
      return Promise.resolve(new Set(['2']))
    }
    const poller = createPrInputPoller(h.deps)
    await poller.poll()
    expect(asked).toEqual([])
    prs.set(WEB, watched(WEB, { comments: [comment('1', 'alice'), comment('2', 'octocat'), comment('3', 'octocat')] }))
    await poller.poll()
    expect(asked).toEqual([[WEB, 'octocat', '1', '2', '3']])
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.inputs).toMatchObject([{ kind: 'comment', title: '2 new comments on acme/web#1' }])
    expect(h.delivered[0]?.inputs[0]?.body).not.toContain('Comment 2')
    await poller.poll()
    expect(asked).toHaveLength(1)
  })

  it('never runs two polls at once', async () => {
    const h = harness(new Map([[WEB, watched(WEB)]]), { [WEB]: ['t1'] })
    await Promise.all([h.poller.poll(), h.poller.poll()])
    expect(h.deps.fetch).toHaveBeenCalledTimes(1)
  })

  describe('while the subagent that owns the PR runs', () => {
    const START = Date.parse('2026-10-27T09:00:00Z')

    /** A harness whose held updates live in memory, as the store keeps them across a restart. */
    function holding(prs: Map<string, WatchedPr | null>, links: Record<string, string[]>) {
      const fix: InputSubtask = { tool_use_id: 'toolu_a', description: 'Fix login', agent_id: 'a1', running: true }
      const subagents: Record<string, InputSubtask> = { toolu_a: fix }
      const h = harness(prs, links, subagents)
      const rows: (HeldInput & { task_id: string; tool_use_id: string; at: string })[] = []
      let next = 0
      const clock = { now: START }
      h.deps.now = () => clock.now
      h.deps.held = {
        hold: async (taskId, toolUseId, inputs, at) => {
          for (const input of inputs) {
            next += 1
            rows.push({ id: next, input, task_id: taskId, tool_use_id: toolUseId, at })
          }
          return Promise.resolve()
        },
        groups: async () => {
          const groups = new Map<string, { task_id: string; tool_use_id: string; since: string }>()
          for (const row of rows) {
            const key = `${row.task_id}>${row.tool_use_id}`
            groups.set(key, groups.get(key) ?? { task_id: row.task_id, tool_use_id: row.tool_use_id, since: row.at })
          }
          return Promise.resolve([...groups.values()])
        },
        of: async (taskId, toolUseId) =>
          Promise.resolve(rows.filter((row) => row.task_id === taskId && row.tool_use_id === toolUseId)),
        drop: async (ids) => {
          for (const id of ids) {
            rows.splice(
              rows.findIndex((row) => row.id === id),
              1,
            )
          }
          return Promise.resolve()
        },
      }
      const end = () => {
        subagents.toolu_a = { ...fix, running: false }
      }
      return { ...h, poller: createPrInputPoller(h.deps), rows, clock, fix, end }
    }

    const review = {
      id: 'r1',
      state: 'CHANGES_REQUESTED',
      body: 'Handle the empty case.',
      url: `${WEB}#pullrequestreview-r1`,
      submitted_at: '2026-10-27T09:05:00Z',
      author: { login: 'alice', bot: false },
      comments: [],
    }

    it('holds its updates, then hands over only the latest of each kind once it ends', async () => {
      const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
      const h = holding(prs, { [WEB]: ['lead>toolu_a', 'peer'] })
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'failure' }))
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'success', head_oid: 'def5678', reviews: [review] }))
      await h.poller.poll()
      expect(h.rows.map((row) => row.input.kind)).toEqual(['ci_failed', 'ci_passed', 'review'])
      expect(h.delivered.map((d) => [d.taskId, d.inputs.map((input) => input.kind)])).toEqual([
        ['peer', ['ci_failed']],
        ['peer', ['ci_passed', 'review']],
      ])

      h.end()
      await h.poller.poll()
      expect(h.rows).toEqual([])
      expect(h.delivered.at(-1)?.taskId).toBe('lead')
      expect(h.delivered.at(-1)?.inputs).toMatchObject([
        { kind: 'ci_passed', subtask: { ...h.fix, running: false } },
        { kind: 'review', subtask: { ...h.fix, running: false } },
      ])
      prs.set(WEB, watched(WEB, { ci: 'failure', head_oid: 'aaa0001', reviews: [review] }))
      await h.poller.poll()
      expect(h.delivered.slice(-2).map((d) => [d.taskId, d.inputs.map((input) => input.kind)])).toEqual([
        ['lead', ['ci_failed']],
        ['peer', ['ci_failed']],
      ])
    })

    it('hands over only the end of a PR that merged while it was held', async () => {
      const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
      const h = holding(prs, { [WEB]: ['lead>toolu_a'] })
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'failure', conflicting: true }))
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'success', head_oid: 'def5678', state: 'merged' }))
      await h.poller.poll()
      h.end()
      await h.poller.poll()
      expect(h.delivered.map((d) => d.inputs.map((input) => input.kind))).toEqual([['merged']])
    })

    it('lets them go after 30 minutes when the subagent never ends', async () => {
      const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
      const h = holding(prs, { [WEB]: ['lead>toolu_a'] })
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'failure' }))
      await h.poller.poll()
      h.clock.now = START + 29 * 60_000
      await h.poller.poll()
      expect(h.delivered).toEqual([])
      h.clock.now = START + 30 * 60_000
      await h.poller.poll()
      expect(h.delivered).toMatchObject([{ taskId: 'lead', inputs: [{ kind: 'ci_failed', subtask: h.fix }] }])
      expect(h.rows).toEqual([])
    })

    it('hands over what a restart left held on the first poll, with no PR left to watch', async () => {
      const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
      const h = holding(prs, { [WEB]: ['lead>toolu_a'] })
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'failure' }))
      await h.poller.poll()
      h.end()
      h.deps.watched = async () => Promise.resolve([])
      await createPrInputPoller(h.deps).poll()
      expect(h.delivered).toMatchObject([{ taskId: 'lead', inputs: [{ kind: 'ci_failed' }] }])
      expect(h.rows).toEqual([])
    })

    it('keeps them held when handing them over fails, and tries again on the next poll', async () => {
      const prs = new Map<string, WatchedPr | null>([[WEB, watched(WEB)]])
      const h = holding(prs, { [WEB]: ['lead>toolu_a'] })
      await h.poller.poll()
      prs.set(WEB, watched(WEB, { ci: 'failure' }))
      await h.poller.poll()
      h.end()
      const deliver = h.deps.deliver
      h.deps.deliver = async () => Promise.reject(new Error('turn failed'))
      await h.poller.poll()
      expect(h.rows).toHaveLength(1)
      expect(h.errors).toEqual([new Error('turn failed')])
      h.deps.deliver = deliver
      await h.poller.poll()
      expect(h.rows).toEqual([])
      expect(h.delivered).toHaveLength(1)
    })
  })
})
