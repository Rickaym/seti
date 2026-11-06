import {
  EA_USAGE_CHANNELS,
  EA_USAGE_KEEP_DAYS,
  EA_USAGE_WINDOW_DAYS,
  type EaLatency,
  type EaUsageChannel,
  type EaUsageRecord,
  type EaUsageStats,
} from '@seti/shared'
import { sql, transaction } from '../db.js'

const DAY_MS = 24 * 60 * 60 * 1000

const daysBefore = (at: string, days: number) => new Date(Date.parse(at) - days * DAY_MS).toISOString()

interface LatencyRow {
  samples: number
  p50: number | null
  p95: number | null
}

interface CallsRow {
  calls_today: number
  calls_window: number
  prompt: number | null
  completion: number | null
  cached: number | null
  tool_calls: number | null
}

const roundOrNull = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value)

const shareOf = (value: number | null | undefined) =>
  value === null || value === undefined ? null : Math.round(value * 1000) / 1000

const latency = (row: LatencyRow | undefined): EaLatency => ({
  samples: row?.samples ?? 0,
  p50_ms: roundOrNull(row?.p50),
  p95_ms: roundOrNull(row?.p95),
})

async function latencies(since: string): Promise<Map<string, LatencyRow>> {
  const rows = await sql<(LatencyRow & { kind: string })[]>`SELECT kind, count(ttfb_ms)::int AS samples,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY ttfb_ms) AS p50,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY ttfb_ms) AS p95
    FROM ea_usage WHERE at >= ${since} GROUP BY kind`
  return new Map(rows.map(({ kind, ...row }) => [kind, row]))
}

async function calls(since: string, at: string, zone: string): Promise<CallsRow | undefined> {
  const [row] = await sql<CallsRow[]>`SELECT
      count(*) FILTER (WHERE (at::timestamptz AT TIME ZONE ${zone})::date
        = (${at}::timestamptz AT TIME ZONE ${zone})::date)::int AS calls_today,
      count(*)::int AS calls_window,
      avg(prompt_tokens)::float8 AS prompt,
      avg(completion_tokens)::float8 AS completion,
      sum(cached_tokens)::float8 / nullif(sum(prompt_tokens), 0) AS cached,
      sum(tool_calls) AS tool_calls
    FROM ea_usage WHERE kind = 'llm' AND at >= ${since}`
  return row
}

async function byChannel(since: string): Promise<{ channels: Record<EaUsageChannel, number>; models: string[] }> {
  const rows = await sql<{ channel: string; model: string | null; calls: number }[]>`SELECT channel, model,
      count(*)::int AS calls FROM ea_usage WHERE kind = 'llm' AND at >= ${since}
    GROUP BY channel, model ORDER BY calls DESC, model`
  const channels = Object.fromEntries(EA_USAGE_CHANNELS.map((channel) => [channel, 0])) as Record<
    EaUsageChannel,
    number
  >
  const models = new Map<string, number>()
  for (const row of rows) {
    if (row.channel in channels) {
      channels[row.channel as EaUsageChannel] += row.calls
    }
    if (row.model !== null) {
      models.set(row.model, (models.get(row.model) ?? 0) + row.calls)
    }
  }
  return { channels, models: [...models].toSorted((a, b) => b[1] - a[1]).map(([model]) => model) }
}

/** The EA's model calls and speech latency, kept for about 30 days. */
export const eaUsage = {
  /** Stores a batch the EA bot reported, and drops rows older than the keep window. */
  add: async (records: EaUsageRecord[], at: string): Promise<number> => {
    const rows = records.map((record) => ({
      at,
      kind: record.kind,
      channel: record.channel,
      model: record.model,
      ttfb_ms: record.ttfb_ms,
      prompt_tokens: record.kind === 'llm' ? record.prompt_tokens : null,
      cached_tokens: record.kind === 'llm' ? record.cached_tokens : null,
      completion_tokens: record.kind === 'llm' ? record.completion_tokens : null,
      tool_calls: record.kind === 'llm' ? record.tool_calls : null,
    }))
    await transaction(async (tx) => {
      await tx`INSERT INTO ea_usage ${tx(rows)}`
      await tx`DELETE FROM ea_usage WHERE at < ${daysBefore(at, EA_USAGE_KEEP_DAYS)}`
    })
    return rows.length
  },
  /** The stats over the last 7 days, with today counted in `zone`. */
  stats: async (zone: string, at: string): Promise<EaUsageStats> => {
    const since = daysBefore(at, EA_USAGE_WINDOW_DAYS)
    const [row, speech, split] = await Promise.all([calls(since, at, zone), latencies(since), byChannel(since)])
    return {
      zone,
      window_days: EA_USAGE_WINDOW_DAYS,
      calls_today: row?.calls_today ?? 0,
      calls_window: row?.calls_window ?? 0,
      by_channel: split.channels,
      ttfb: latency(speech.get('llm')),
      avg_prompt_tokens: roundOrNull(row?.prompt),
      avg_completion_tokens: roundOrNull(row?.completion),
      cached_share: shareOf(row?.cached),
      tool_calls: row?.tool_calls ?? 0,
      models: split.models,
      stt: latency(speech.get('stt')),
      tts: latency(speech.get('tts')),
    }
  },
}
