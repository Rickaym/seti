import type { HomeSummary } from '@seti/shared'
import { beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { sql } from '../db.js'
import { shippingStreak } from '../home.js'
import type { PrSnapshot } from '../pr-events.js'
import { prWatch } from '../store/pr-watch.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { trackToolCalls } from '../tool-calls.js'

const app = createApp()
const DAY = 86_400_000
const NOW = Date.now()
const daysAgo = (days: number, hours = 0) => new Date(NOW - days * DAY - hours * 3_600_000).toISOString()

const SHIPPED = 'https://github.com/acme/web/pull/1'
const SHARED = 'https://github.com/acme/web/pull/2'
const OLD = 'https://github.com/acme/web/pull/3'
const DROPPED = 'https://github.com/acme/web/pull/4'

const merged: PrSnapshot = { state: 'merged', conflicting: false, ci: null, review_ids: [], comment_ids: [] }

async function mergedAt(url: string, at: string): Promise<void> {
  await prWatch.save(url, merged)
  await sql`UPDATE pr_watch SET checked_at = ${at} WHERE pr_url = ${url}`
}

async function message(taskId: string, payload: object, at: string): Promise<void> {
  await sql`INSERT INTO task_message (task_id, kind, payload, created_at)
    VALUES (${taskId}, 'sdk', ${JSON.stringify(payload)}, ${at})`
}

const result = (cost: number, ms: number) => ({ type: 'result', duration_ms: ms, seti_turn_cost_usd: cost })

const mcpCall = (name: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: `toolu_${name}`, name, input: { note: '"name":"mcp__fake__x' } }] },
})

async function get(path: string, auth = USER_AUTH): Promise<Response> {
  return app.request(`/api/home${path}`, { headers: { host: 'localhost', ...auth } })
}

beforeAll(async () => {
  await sql`INSERT INTO task (id, title, cwd, status, input_mode, created_at, updated_at) VALUES
    ('home-a', 'A', '/tmp', 'idle', 'wake', ${daysAgo(40)}, ${daysAgo(0)}),
    ('home-b', 'B', '/tmp', 'running', 'wake', ${daysAgo(40)}, ${daysAgo(0)})`
  await message('home-a', result(1.5, 60_000), daysAgo(0))
  await message('home-a', result(2, 120_000), daysAgo(10))
  await message('home-a', result(9, 1), daysAgo(35))
  await message('home-b', mcpCall('mcp__github__create_pull_request'), daysAgo(2))
  await message('home-b', mcpCall('mcp__github__get_issue'), daysAgo(2))
  await message('home-b', mcpCall('mcp__linear__search'), daysAgo(3))
  await message('home-b', mcpCall('mcp__github__old'), daysAgo(40))
  await sql`INSERT INTO task_pr (task_id, pr_url, linked_at, source) VALUES
    ('home-b', ${SHARED}, ${daysAgo(5)}, 'agent')`
  await sql`INSERT INTO task_pr_dismissed (task_id, pr_url, at) VALUES
    ('home-a', ${SHIPPED}, ${daysAgo(1)}), ('home-a', ${SHARED}, ${daysAgo(3)}),
    ('home-a', ${OLD}, ${daysAgo(34)}), ('home-b', ${DROPPED}, ${daysAgo(6)})`
  await mergedAt(SHIPPED, daysAgo(1))
  await mergedAt(SHARED, daysAgo(3))
  await mergedAt(OLD, daysAgo(34))
  await mergedAt(DROPPED, daysAgo(2))
})

describe('GET /api/home', () => {
  it('counts merged PRs, turns, cost and time running per agent and in total', async () => {
    const res = await get('?zone=UTC')
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: HomeSummary }
    expect(data.zone).toBe('UTC')
    const a = data.agents.find((agent) => agent.task_id === 'home-a')
    expect(a).toMatchObject({ merged_7d: 2, merged_30d: 2, turns_7d: 1, turns_30d: 2, cost_30d_usd: 3.5 })
    expect(a?.run_ms_30d).toBe(180_000)
    const b = data.agents.find((agent) => agent.task_id === 'home-b')
    expect(b).toMatchObject({ merged_30d: 1, turns_30d: 0 })
    expect(b?.mcp).toEqual([
      { server: 'github', calls: 2 },
      { server: 'linear', calls: 1 },
    ])
    expect(data.totals).toMatchObject({ merged_7d: 2, merged_30d: 2, turns_30d: 2, cost_7d_usd: 1.5 })
    expect(data.days).toHaveLength(30)
    expect(data.days.at(-1)).toMatchObject({ merged: 0, turns: 1, cost_usd: 1.5, run_ms: 60_000 })
    expect(data.streak_days).toBe(1)
  })

  it('lists the latest merges newest first, each PR once with every agent it was linked to', async () => {
    const { data } = (await (await get('?zone=UTC')).json()) as { data: HomeSummary }
    expect(data.recent.map((merge) => merge.pr_url)).toEqual([SHIPPED, SHARED])
    expect(data.recent[0]).toMatchObject({ merged_at: daysAgo(1), task_ids: ['home-a'] })
    expect(data.recent[1]?.task_ids.toSorted()).toEqual(['home-a', 'home-b'])
  })

  it('shows the calls running now, with the MCP server and subagent they belong to', async () => {
    trackToolCalls('home-b', {
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      message: { content: [{ type: 'tool_use', id: 'toolu_live', name: 'mcp__github__merge', input: {} }] },
    } as never)
    const { data } = (await (await get('?zone=UTC')).json()) as { data: HomeSummary }
    expect(data.live).toEqual([
      expect.objectContaining({
        task_id: 'home-b',
        tool: 'mcp__github__merge',
        server: 'github',
        subagent: 'toolu_agent',
      }),
    ])
  })

  it('lets the EA read it and refuses an unknown timezone', async () => {
    expect((await get('', EA_AUTH)).status).toBe(200)
    expect((await get('?zone=Mars/Olympus')).status).toBe(400)
  })
})

describe('shippingStreak', () => {
  const days = (counts: number[]) => counts.map((n) => ({ merged: n }))
  it('counts back from today, or from yesterday while today has none', () => {
    expect(shippingStreak(days([1, 0, 1, 1, 1]))).toBe(3)
    expect(shippingStreak(days([1, 1, 1, 0]))).toBe(3)
    expect(shippingStreak(days([1, 0, 0]))).toBe(0)
    expect(shippingStreak(days([1, 1]))).toBe(2)
  })
})
