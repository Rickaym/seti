import type { SubscriptionFacts } from '../store/dream-tidies.js'

const DAY_MS = 24 * 60 * 60_000

/** How long a subscription has existed and delivered nothing before a dream is asked about it. */
export const QUIET_DAYS = 30

/** The instant the quiet window starts, as Seti stores times. */
export const quietSince = (at: number) => new Date(at - QUIET_DAYS * DAY_MS).toISOString()

const daysSince = (iso: string, at: number) => Math.floor((at - Date.parse(iso)) / DAY_MS)

/**
 * Whether Seti's rule finds a subscription unused: at least `QUIET_DAYS` old, nothing delivered
 * to it for as long, and not one the user put back after a dream removed it.
 */
export function unused(facts: SubscriptionFacts, at: number): boolean {
  const since = quietSince(at)
  return !facts.kept && facts.created_at <= since && (facts.last_delivered_at ?? '') < since
}

/** Names and kinds come from the user and from senders: one short line each, as data. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 60)

const filterWords = (events: string | null) => {
  const kinds = events === null ? null : (JSON.parse(events) as string[])
  return kinds === null ? 'every event' : kinds.map(oneLine).join(', ')
}

function sourceState(facts: SubscriptionFacts): string {
  if (facts.enabled === null) {
    return ''
  }
  const every = facts.interval_s === null ? '' : `, every ${String(facts.interval_s)} s`
  const schedule = facts.cron === null ? every : `, ${facts.cron}`
  const on = facts.failing === true ? 'on but failing' : 'on'
  return `; the ${facts.source} is ${facts.enabled ? on : 'off'}${schedule}`
}

function activity(facts: SubscriptionFacts): string {
  if (facts.channel_events === 0) {
    return `the channel took no events in ${String(QUIET_DAYS)} days`
  }
  const kinds = facts.kinds.length === 0 ? '' : `, kinds ${facts.kinds.map(oneLine).join(', ')}`
  return `the channel took ${String(facts.channel_events)} events in ${String(QUIET_DAYS)} days${kinds}, none for this agent`
}

/** One listed subscription as the dream reads it: names, dates and counts, never a secret. */
function factsLine(facts: SubscriptionFacts, at: number): string {
  const last =
    facts.last_delivered_at === null
      ? 'nothing ever delivered'
      : `last delivery ${facts.last_delivered_at.slice(0, 10)} (${String(daysSince(facts.last_delivered_at, at))} days ago)`
  return [
    `sub-${String(facts.id)}: ${facts.source} "${oneLine(facts.channel_name)}", takes ${filterWords(facts.events)}`,
    `subscribed ${facts.created_at.slice(0, 10)}; ${last}; ${activity(facts)}${sourceState(facts)}`,
  ].join('; ')
}

/** Whether a subscription still is what the dream decided on: same channel, filter and delivery. */
export const sameSubscription = (a: SubscriptionFacts, b: SubscriptionFacts) =>
  a.id === b.id && a.channel_id === b.channel_id && a.events === b.events && a.delivery === b.delivery

/** The list a dream reads beside its digest; null when nothing is unused. */
export function configList(night: string, listed: readonly SubscriptionFacts[], others: number, at: number) {
  if (listed.length === 0) {
    return null
  }
  return [
    `# Configuration Seti found unused, night of ${night}`,
    '',
    `Channel subscriptions of this agent that are ${String(QUIET_DAYS)} days old or more and delivered nothing in the last ${String(QUIET_DAYS)} days:`,
    '',
    ...listed.map((facts) => `- ${factsLine(facts, at)}`),
    '',
    `Its other subscriptions (${String(others)}) delivered within ${String(QUIET_DAYS)} days and are not listed.`,
    '',
  ].join('\n')
}
