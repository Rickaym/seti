import type { Page } from '@playwright/test'
import type { ChannelHealth, ChannelInfo, Envelope, RunWindowStats } from '@seti/shared'
import { NOW } from './clock.js'

/** Loopback origins of the fake services and the hosts the pictures show instead. */
let replacements: [from: string, to: string][] = []

export function showHostsAs(pairs: [from: string, to: string][]): void {
  replacements = pairs
}

const swapHosts = (text: string) => replacements.reduce((out, [from, to]) => out.replaceAll(from, to), text)

const week = (intervalS: number, days: number): RunWindowStats => {
  const runs = Math.floor((days * 86_400) / intervalS)
  return {
    days,
    runs,
    expected: runs,
    ok_pct: 100,
    on_time_pct: 100,
    late_p50_ms: 400,
    late_p95_ms: 900,
    late_max_ms: 1800,
    missed: 0,
    longest_gap_s: intervalS,
    duration_p95_ms: 600,
    errors: [],
  }
}

const healthy = (intervalS: number): ChannelHealth => ({
  stale: false,
  overdue_s: 0,
  windows: [week(intervalS, 7), week(intervalS, 30)],
})

/** Runs as the schedule makes them, each taking a steady fraction of a second. */
const scheduled = <T extends { trigger: string; duration_ms: number }>(runs: T[]) =>
  runs.map((run, n) => ({ ...run, trigger: 'schedule' as const, duration_ms: 380 + 40 * n }))

const after = (iso: string | null, seconds: number) =>
  iso === null ? null : new Date(Date.parse(iso) + seconds * 1000).toISOString()

/**
 * Pollers and the reminder are seeded paused so no timer runs them against the clock; the
 * pictures show them on schedule, with their last run from the database.
 */
function onSchedule(info: ChannelInfo): ChannelInfo {
  if (info.source === 'poller') {
    const { poller } = info
    const last = poller.runs[0]?.started_at ?? null
    const next = after(last, poller.interval_s)
    const schedule = { enabled: true, status: 'ok' as const, last_run_at: last, next_run_at: next }
    const runs = scheduled(poller.runs)
    return { ...info, poller: { ...poller, ...schedule, runs, health: healthy(poller.interval_s) } }
  }
  if (info.source === 'reminder') {
    const { reminder } = info
    const last = reminder.runs[0]?.started_at ?? null
    const next = after(last, reminder.interval_s)
    const schedule = { enabled: true, status: 'ok' as const, last_run_at: last, next_run_at: next }
    const runs = scheduled(reminder.runs)
    return { ...info, reminder: { ...reminder, ...schedule, runs, health: healthy(reminder.interval_s) } }
  }
  return info
}

/** Where each channel sits in the list and when it was made, in days before NOW. */
const MADE: Record<string, number> = {
  'Payments provider status': 40,
  'Support tickets': 38,
  'Node.js releases': 35,
  'GitHub acme/storefront': 30,
  'Storefront deploys': 28,
  'Friday release check': 21,
}

const HOOK_IDS: Record<string, string> = {
  'GitHub acme/storefront': 'h7Qm2xV9kR4tLp8sWn3Zc6Yb',
  'Storefront deploys': 'd2Fj8nR5vT1qKw7mXc4Hs9Pe',
}

/** Fixed dates and a public hook URL in place of the ones the run made. */
function settled(info: ChannelInfo): ChannelInfo {
  const made = new Date(NOW - (MADE[info.name] ?? 20) * 86_400_000).toISOString()
  const dated = { ...info, created_at: made, updated_at: made }
  if (dated.source !== 'webhook') {
    return onSchedule(dated)
  }
  const hook = HOOK_IDS[info.name] ?? 'x'
  return { ...dated, secret_rotated_at: null, public_url: `https://seti.acme.example/hooks/${hook}` }
}

/** Rewrites channel answers: fictional hosts for loopback ones, and paused schedules running. */
export async function mockChannels(page: Page): Promise<void> {
  await page.route(/\/api\/(channels|ea\/channels|tasks\/[^/]+\/channels)(\/[^?]*)?(\?.*)?$/, async (route) => {
    const response = await route.fetch()
    const text = swapHosts(await response.text())
    const url = new URL(route.request().url())
    if (url.pathname !== '/api/channels' || !response.ok()) {
      await route.fulfill({ response, body: text })
      return
    }
    const body = JSON.parse(text) as Envelope<ChannelInfo[]>
    const data = body.data.map(settled).sort((a, b) => a.created_at.localeCompare(b.created_at))
    await route.fulfill({ response, json: { ...body, data } })
  })
}
