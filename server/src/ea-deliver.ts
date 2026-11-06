import type { AttentionRoute, EaInboxDelivered, EaInboxItem, EaInboxVia } from '@seti/shared'
import { audit } from './audit.js'
import { routeAttention, tierOfItem } from './ea-attention.js'
import { noticeText } from './ea-inbox.js'
import { pushEaItem } from './notifications.js'
import { eaInbox } from './store/inbox.js'

const SWEEP_BATCH = 50

/**
 * Gives each delivered item its one surface. Spoken on a call, the call carried it. Otherwise the
 * attention router picks: a push goes out now, and a toast shows an item no report of the EA's
 * follows, those in `notify` or posted by Seti while the EA is away.
 */
async function routeDelivered(
  items: readonly EaInboxItem[],
  via: EaInboxVia,
  notify: readonly number[],
  at: Date,
): Promise<EaInboxItem[]> {
  const routes = new Map<number, AttentionRoute>()
  for (const item of items) {
    const event = { tier: tierOfItem(item), viaEa: true, callable: false }
    routes.set(item.id, via === 'voice' ? 'call' : await routeAttention(event, at.getTime()))
  }
  const told = new Set(notify)
  const toast = items.filter((item) => routes.get(item.id) === 'toast' && (via === 'seti' || told.has(item.id)))
  await eaInbox.route(
    routes,
    toast.map((item) => item.id),
  )
  const routed = items.map((item) => ({ ...item, route: routes.get(item.id) ?? null }))
  for (const item of routed.filter((each) => each.route === 'push')) {
    await pushEaItem(item, at.getTime())
  }
  return routed
}

/**
 * Marks items delivered, posts them to the EA history, routes each to its one surface, and
 * records who took them and where they went.
 */
export async function deliverInbox(
  ids: readonly number[],
  via: EaInboxVia,
  at = new Date(),
  notify: readonly number[] = [],
): Promise<EaInboxDelivered> {
  const delivered = await eaInbox.deliver({ ids, via }, at.toISOString(), noticeText)
  if (delivered.items.length === 0) {
    return delivered
  }
  const items = await routeDelivered(delivered.items, via, notify, at)
  const count = items.length
  const where = { voice: 'on a call', chat: 'in the EA chat', seti: 'in the EA chat while the EA was away' }[via]
  await audit.record({
    actor: 'system',
    kind: 'ea.inbox_delivered',
    subject_type: 'ea',
    summary: `Delivered ${String(count)} inbox ${count === 1 ? 'item' : 'items'} ${where}`,
    detail: {
      via: via === 'seti' ? 'system' : 'ea',
      surface: via,
      ids: items.map((item) => String(item.id)),
      kinds: items.map((item) => item.kind),
      routes: items.map((item) => item.route ?? 'none'),
    },
  })
  return { ...delivered, items }
}

/** How long the EA may go without asking for its inbox before Seti posts events for it. */
export const EA_ABSENT_MS = 60_000
const SWEEP_MS = 15_000

const startedAt = Date.now()
let lastEaPoll: number | null = null

/** The EA asked for its inbox; while it keeps asking, it delivers everything itself. */
export function eaPolled(at = Date.now()): void {
  lastEaPoll = at
}

const eaAbsent = (at: number) => at - (lastEaPoll ?? startedAt) > EA_ABSENT_MS

/**
 * With the EA away, events and reminders go to the EA chat as they are, so the unread count and
 * the chat still show them. Follow-ups wait for the EA, which checks before it reports.
 */
export async function sweepInbox(at = new Date()): Promise<number> {
  if (!eaAbsent(at.getTime())) {
    return 0
  }
  const due = await eaInbox.due(at.toISOString(), SWEEP_BATCH, [
    'watch_event',
    'channel_event',
    'team_mention',
    'reminder',
  ])
  if (due.length === 0) {
    return 0
  }
  return (
    await deliverInbox(
      due.map((item) => item.id),
      'seti',
      at,
    )
  ).items.length
}

export function startInboxSweeper(): void {
  setInterval(() => {
    sweepInbox().catch((e: unknown) => {
      process.stderr.write(`ea inbox: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }, SWEEP_MS).unref()
}
