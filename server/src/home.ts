import {
  HOME_DAYS,
  HOME_RECENT_LIMIT,
  type HomeAgentStats,
  type HomeDay,
  type HomeLiveCall,
  type HomeMcpUse,
  type HomeMerge,
  type HomeQuery,
  type HomeSummary,
  type HomeTally,
} from '@seti/shared'
import { mcpUse } from './home-mcp.js'
import { homeStore, type MergedLink, type TurnDay } from './store/home.js'
import { openToolCalls } from './tool-calls.js'

const DAY_MS = 86_400_000
/** Counts are redone at most this often, and only after a message is stored or a PR merges. */
const RECOUNT_MS = 5000
/** Zones reach 14 hours from UTC, so a day's rows can start that long before UTC midnight. */
const ZONE_SLACK_MS = 15 * 3_600_000
/** Readers in different timezones or days each get their own counts, up to this many. */
const CACHE_KEYS = 16

type Counted = Omit<HomeSummary, 'live'>

const cache = new Map<string, { at: number; mark: string; summary: Promise<Counted> }>()

const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const dayIn = (zone: string, at: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)

/** The `length` days ending on `today`, as `YYYY-MM-DD`, oldest first. */
function lastDays(today: string, length: number): string[] {
  const end = Date.parse(`${today}T00:00:00Z`)
  return Array.from({ length }, (_, i) => new Date(end - (length - 1 - i) * DAY_MS).toISOString().slice(0, 10))
}

const EMPTY_TALLY: HomeTally = {
  merged_7d: 0,
  merged_30d: 0,
  turns_7d: 0,
  turns_30d: 0,
  cost_7d_usd: 0,
  cost_30d_usd: 0,
  run_ms_7d: 0,
  run_ms_30d: 0,
}

/** A tally with one day of turns added; `week` when the day falls in the last 7. */
function withTurns(tally: HomeTally, row: TurnDay, week: boolean): HomeTally {
  const inWeek = week ? 1 : 0
  return {
    ...tally,
    turns_30d: tally.turns_30d + row.turns,
    cost_30d_usd: tally.cost_30d_usd + row.cost_usd,
    run_ms_30d: tally.run_ms_30d + row.run_ms,
    turns_7d: tally.turns_7d + row.turns * inWeek,
    cost_7d_usd: tally.cost_7d_usd + row.cost_usd * inWeek,
    run_ms_7d: tally.run_ms_7d + row.run_ms * inWeek,
  }
}

const withMerge = (tally: HomeTally, week: boolean): HomeTally => ({
  ...tally,
  merged_30d: tally.merged_30d + 1,
  merged_7d: tally.merged_7d + (week ? 1 : 0),
})

/** Days in a row with a merge, ending today, or yesterday while today has none yet. */
export function shippingStreak(days: readonly Pick<HomeDay, 'merged'>[]): number {
  const merged = days.map((day) => day.merged > 0)
  if (merged.at(-1) === false) {
    merged.pop()
  }
  return merged.length - merged.lastIndexOf(false) - 1
}

interface Sources {
  days: string[]
  turns: TurnDay[]
  merged: MergedLink[]
  mcp: Map<string, HomeMcpUse[]>
}

const weekStartOf = (days: readonly string[]) => days.at(-HOME_DAYS.week) ?? ''

const byShipped = (a: HomeAgentStats, b: HomeAgentStats) =>
  b.merged_30d === a.merged_30d ? b.turns_30d - a.turns_30d : b.merged_30d - a.merged_30d

function agentStats({ days, turns, merged, mcp }: Sources): HomeAgentStats[] {
  const weekStart = weekStartOf(days)
  const agents = new Map<string, HomeAgentStats>()
  const agent = (taskId: string): HomeAgentStats =>
    agents.get(taskId) ?? { task_id: taskId, ...EMPTY_TALLY, mcp: mcp.get(taskId) ?? [] }
  for (const row of turns) {
    const stats = agent(row.task_id)
    agents.set(row.task_id, { ...stats, ...withTurns(stats, row, row.day >= weekStart) })
  }
  for (const link of merged) {
    const stats = agent(link.task_id)
    agents.set(link.task_id, { ...stats, ...withMerge(stats, link.day >= weekStart) })
  }
  return [...agents.values()].sort(byShipped)
}

interface DayWork {
  turns: number
  cost_usd: number
  run_ms: number
}

const NO_WORK: DayWork = { turns: 0, cost_usd: 0, run_ms: 0 }

/** Turns, cost and time running summed per day over every agent. */
function workByDay(turns: readonly TurnDay[]): Map<string, DayWork> {
  const work = new Map<string, DayWork>()
  for (const row of turns) {
    const day = work.get(row.day) ?? NO_WORK
    work.set(row.day, {
      turns: day.turns + row.turns,
      cost_usd: day.cost_usd + row.cost_usd,
      run_ms: day.run_ms + row.run_ms,
    })
  }
  return work
}

/** The first link Seti saw per merged PR, with every agent the PR was linked to. */
function mergesByPr(merged: readonly MergedLink[]): Map<string, HomeMerge> {
  const merges = new Map<string, HomeMerge>()
  for (const link of merged) {
    const known = merges.get(link.pr_url)
    merges.set(
      link.pr_url,
      known === undefined
        ? { pr_url: link.pr_url, merged_at: link.merged_at, task_ids: [link.task_id] }
        : { ...known, task_ids: [...new Set([...known.task_ids, link.task_id])] },
    )
  }
  return merges
}

/** Every agent together, per day and as the latest merges; a PR linked to two agents counts once. */
function totals({ days, turns, merged }: Sources): Pick<Counted, 'totals' | 'days' | 'recent'> {
  const weekStart = weekStartOf(days)
  const work = workByDay(turns)
  const mergedOn = new Map<string, number>()
  let tally = EMPTY_TALLY
  for (const row of turns) {
    tally = withTurns(tally, row, row.day >= weekStart)
  }
  const seen = new Set<string>()
  for (const link of merged) {
    if (!seen.has(link.pr_url)) {
      seen.add(link.pr_url)
      tally = withMerge(tally, link.day >= weekStart)
      mergedOn.set(link.day, (mergedOn.get(link.day) ?? 0) + 1)
    }
  }
  const recent = [...mergesByPr(merged).values()]
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))
    .slice(0, HOME_RECENT_LIMIT)
  return {
    totals: tally,
    days: days.map((day) => ({ day, merged: mergedOn.get(day) ?? 0, ...(work.get(day) ?? NO_WORK) })),
    recent,
  }
}

async function countIn(zone: string, today: string, now: number): Promise<Counted> {
  const days = lastDays(today, HOME_DAYS.month)
  const [first = '', last = ''] = [days[0], days.at(-1)]
  const since = new Date(Date.parse(`${first}T00:00:00Z`) - ZONE_SLACK_MS).toISOString()
  const fromId = await homeStore.firstIdSince(since)
  const [turns, merged, mcp] = await Promise.all([
    fromId === null ? [] : homeStore.turnDays(since, zone, fromId),
    homeStore.mergedLinks(since, zone),
    mcpUse(now),
  ])
  const inWindow = (row: { day: string }) => row.day >= first && row.day <= last
  const sources = { days, turns: turns.filter(inWindow), merged: merged.filter(inWindow), mcp }
  const summed = totals(sources)
  return { zone, ...summed, streak_days: shippingStreak(summed.days), agents: agentStats(sources) }
}

function liveCalls(): HomeLiveCall[] {
  return openToolCalls().map(({ taskId, call }) => ({
    task_id: taskId,
    tool: call.name,
    server: /^mcp__(.+?)__/.exec(call.name)?.[1] ?? null,
    subagent: call.parent,
    since: new Date(call.since).toISOString(),
  }))
}

/** The reader's timezone, the Seti host's when left out, or UTC when Postgres does not know it. */
export async function readerZone(query: HomeQuery): Promise<string> {
  const wanted = query.zone ?? hostZone()
  return (await homeStore.knowsZone(wanted)) ? wanted : 'UTC'
}

/** The counts for the reader's timezone and day. */
async function counted(query: HomeQuery, now: number): Promise<Counted> {
  const zone = await readerZone(query)
  const today = dayIn(zone, now)
  const key = `${zone} ${today}`
  const mark = await homeStore.mark()
  const hit = cache.get(key)
  if (hit !== undefined && (hit.mark === mark || now - hit.at < RECOUNT_MS)) {
    return hit.summary
  }
  if (cache.size >= CACHE_KEYS) {
    cache.clear()
  }
  const summary = countIn(zone, today, now)
  cache.set(key, { at: now, mark, summary })
  summary.catch(() => {
    cache.delete(key)
  })
  return summary
}

/** The shipping metrics: PRs merged, turns, cost and time running, and the calls running now. */
export async function homeSummary(query: HomeQuery = {}, now = Date.now()): Promise<HomeSummary> {
  return { ...(await counted(query, now)), live: liveCalls() }
}
