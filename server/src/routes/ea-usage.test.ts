import type { EaUsageChannel, EaUsageRecord, EaUsageStats } from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { sql } from '../db.js'
import { eaUsage } from '../store/ea-usage.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH, origin: 'http://127.0.0.1:3006' }
const BOT = { ...LOCAL, ...EA_AUTH }
const DAY_MS = 24 * 60 * 60 * 1000

async function send(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  return app.request(`/api/ea${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function data<T>(res: Response): Promise<T> {
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const modelCall = (
  channel: EaUsageChannel,
  ttfb: number,
  [prompt, cached]: [number, number],
  tools = 0,
): EaUsageRecord => ({
  kind: 'llm',
  channel,
  model: 'gpt-4.1',
  ttfb_ms: ttfb,
  prompt_tokens: prompt,
  cached_tokens: cached,
  completion_tokens: 40,
  tool_calls: tools,
})

const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

beforeEach(async () => {
  await sql`DELETE FROM ea_usage`
})

describe('EA usage', () => {
  it('stores what the bot reports and serves the 7-day stats', async () => {
    const records = [
      modelCall('voice', 600, [16_000, 12_000], 2),
      modelCall('voice', 800, [16_000, 12_000]),
      modelCall('chat', 1000, [14_000, 0], 1),
      modelCall('inbox', 3000, [10_000, 4000]),
      { kind: 'stt', channel: 'voice', model: 'nova-3', ttfb_ms: 300 },
      { kind: 'tts', channel: 'voice', model: null, ttfb_ms: 200 },
    ]
    expect(await data(await send('POST', '/usage', BOT, { records }))).toEqual({ recorded: 6 })
    await eaUsage.add([modelCall('chat', 9000, [50_000, 0])], ago(8))

    const stats = await data<EaUsageStats>(await send('GET', '/usage?zone=UTC', LOCAL))
    expect(stats).toMatchObject({
      zone: 'UTC',
      window_days: 7,
      calls_today: 4,
      calls_window: 4,
      by_channel: { voice: 2, chat: 1, inbox: 1 },
      ttfb: { samples: 4, p50_ms: 900 },
      avg_prompt_tokens: 14_000,
      avg_completion_tokens: 40,
      cached_share: 0.5,
      tool_calls: 3,
      models: ['gpt-4.1'],
      stt: { samples: 1, p50_ms: 300, p95_ms: 300 },
      tts: { samples: 1, p50_ms: 200, p95_ms: 200 },
    })
    expect(stats.ttfb.p95_ms).toBeGreaterThan(2500)
  })

  it('answers with empty stats before the EA made any call', async () => {
    const stats = await data<EaUsageStats>(await send('GET', '/usage', LOCAL))
    expect(stats).toMatchObject({
      calls_today: 0,
      calls_window: 0,
      ttfb: { samples: 0, p50_ms: null, p95_ms: null },
      avg_prompt_tokens: null,
      cached_share: null,
      tool_calls: 0,
      models: [],
    })
  })

  it('drops rows older than 30 days when new ones arrive', async () => {
    await eaUsage.add([modelCall('chat', 900, [1000, 0])], ago(31))
    await eaUsage.add([modelCall('chat', 900, [1000, 0])], ago(29))
    await eaUsage.add([modelCall('voice', 900, [1000, 0])], new Date().toISOString())
    const rows = await sql<{ channel: string }[]>`SELECT channel FROM ea_usage ORDER BY at`
    expect(rows.map((row) => row.channel)).toEqual(['chat', 'voice'])
  })

  it('takes reports only from the EA bot, and only numbers and labels', async () => {
    const records = [modelCall('chat', 500, [100, 0])]
    expect((await send('POST', '/usage', LOCAL, { records })).status).toBe(403)
    const withText = [{ ...modelCall('chat', 500, [100, 0]), text: 'What is running?' }]
    expect((await send('POST', '/usage', BOT, { records: withText })).status).toBe(400)
    const prose = [{ ...modelCall('chat', 500, [100, 0]), model: 'tell me a secret' }]
    expect((await send('POST', '/usage', BOT, { records: prose })).status).toBe(400)
    expect((await send('POST', '/usage', BOT, { records: [] })).status).toBe(400)
    expect(await sql`SELECT 1 FROM ea_usage`).toHaveLength(0)
  })
})
