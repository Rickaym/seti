import { randomUUID } from 'node:crypto'
import {
  agentUrl,
  NO_CLOSING_LINE,
  type AttentionBrief,
  type AttentionBriefLine,
  type AttentionTiers,
  type EaInboxItem,
  type Task,
} from '@seti/shared'
import { tasks } from './db.js'
import { eaTaskIds } from './ea-attention.js'
import { needsYouTasks } from './needs-you-count.js'
import { notifyBody } from './notifications.js'
import { onReturn } from './presence.js'
import { eaInbox } from './store/inbox.js'
import { notificationSettings } from './store/notifications.js'

const NEEDS_YOU_LISTED = 5
const CHANGED_LISTED = 6
const ITEMS_SCAN = 50
const EA_CHAT_URL = '/#ea'

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const say = (count: number) => NUMBER_WORDS[count] ?? String(count)
const plural = (count: number, one: string, many: string) => `${say(count)} ${count === 1 ? one : many}`

/** The brief in one breath, such as "Two agents finished and one needs you." */
export function briefSentence(needsYou: number, finished: number, updates: number): string {
  const parts = [
    ...(finished > 0 ? [plural(finished, 'agent finished', 'agents finished')] : []),
    ...(updates > 0 ? [plural(updates, 'update came in', 'updates came in')] : []),
  ]
  if (needsYou > 0) {
    parts.push(
      parts.length > 0
        ? plural(needsYou, 'needs you', 'need you')
        : plural(needsYou, 'agent needs you', 'agents need you'),
    )
  }
  const last = parts.pop() ?? ''
  const text = parts.length > 0 ? `${parts.join(', ')} and ${last}` : last
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

const agentLine = (task: Task, text: string): AttentionBriefLine => ({
  task_id: task.id,
  title: task.title,
  text,
  url: agentUrl(task.id),
})

const itemLine = (item: EaInboxItem): AttentionBriefLine => ({
  task_id: item.task_id,
  title: item.source,
  text: item.title,
  url: item.task_id === null ? EA_CHAT_URL : agentUrl(item.task_id),
})

interface Changed {
  finished: AttentionBriefLine[]
  updates: AttentionBriefLine[]
}

/** Agents whose turn ended since the user left, and EA items about anything else, newest first. */
async function changedSince(since: string, skip: ReadonlySet<string>, tiers: AttentionTiers): Promise<Changed> {
  const [list, carried, items] = await Promise.all([tasks.list(), eaTaskIds(), eaInbox.briefed(since, ITEMS_SCAN)])
  const watched = new Set(carried)
  const finished = list
    .filter((task) => !skip.has(task.id) && !task.notifications_muted && task.updated_at > since)
    .filter((task) => task.status === 'idle' && tiers[watched.has(task.id) ? 'digest' : 'active'] !== 'off')
    .map((task) => agentLine(task, task.closing_line ?? NO_CLOSING_LINE))
  const listed = new Set([...skip, ...finished.flatMap((line) => (line.task_id === null ? [] : [line.task_id]))])
  const updates: AttentionBriefLine[] = []
  for (const item of items) {
    if (item.task_id === null || !listed.has(item.task_id)) {
      updates.push(itemLine(item))
      if (item.task_id !== null) {
        listed.add(item.task_id)
      }
    }
  }
  return { finished, updates }
}

/**
 * What happened between `since` and `at`: agents that need the user now, then one line per agent
 * that changed, in its own closing line or its notice's own text. Null when nothing did.
 */
export async function buildBrief(since: string, at: string): Promise<AttentionBrief | null> {
  const [waiting, tiers] = await Promise.all([needsYouTasks(), notificationSettings.get()])
  const needing = waiting.filter((task) => !task.notifications_muted)
  const needs_you = await Promise.all(
    needing.slice(0, NEEDS_YOU_LISTED).map(async (task) => agentLine(task, await notifyBody(task, 'needs_you'))),
  )
  const { finished, updates } = await changedSince(since, new Set(needing.map((task) => task.id)), tiers)
  const changed = [...finished, ...updates]
  if (needing.length === 0 && changed.length === 0) {
    return null
  }
  return {
    id: randomUUID(),
    since,
    at,
    needs_you,
    changed: changed.slice(0, CHANGED_LISTED),
    more: Math.max(0, needing.length - NEEDS_YOU_LISTED) + Math.max(0, changed.length - CHANGED_LISTED),
    summary: briefSentence(needing.length, finished.length, updates.length),
  }
}

let pending: Promise<AttentionBrief | null> | null = null
let listening = false

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Builds the brief when the user comes back; one still waiting extends back to when it began. */
export function briefOnReturn(): void {
  if (listening) {
    return
  }
  listening = true
  onReturn((left, at) => {
    const before = pending
    pending = (async () => {
      const earlier = before === null ? null : await before
      const since = earlier?.since ?? new Date(left).toISOString()
      return buildBrief(since, new Date(at).toISOString())
    })().catch((e: unknown) => {
      process.stderr.write(`attention: could not build the brief: ${errorText(e)}\n`)
      return null
    })
  })
}

/** The brief waiting for the user, if any. */
export async function currentBrief(): Promise<AttentionBrief | null> {
  return (await pending) ?? null
}

/** Drops the brief once the user dismissed it or the EA told it; true when it was there. */
export async function closeBrief(id: string): Promise<boolean> {
  const current = pending
  if ((await current)?.id !== id || pending !== current) {
    return false
  }
  pending = null
  return true
}
