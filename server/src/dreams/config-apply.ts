import type { DreamConfigDecision, DreamRun, DreamTidy, Task } from '@seti/shared'
import { audit } from '../audit.js'
import { subscriptions } from '../channels/subscriptions.js'
import { dreamProposals, PROPOSALS_PER_DREAM } from '../store/dream-proposals.js'
import { dreamTidies, type SubscriptionFacts } from '../store/dream-tidies.js'
import { configList, quietSince, sameSubscription, unused } from './config-stale.js'

/** The most configuration changes Seti applies for one dream. */
export const TIDIES_PER_DREAM = 5

/** What Seti listed for one dream, kept by Seti: the file the dream reads changes nothing here. */
export interface ConfigSnapshot {
  items: ReadonlyMap<string, SubscriptionFacts>
  /** The list as the dream reads it; null when nothing is unused. */
  text: string | null
}

type Run = Pick<DreamRun, 'id' | 'task_id' | 'night'>

/** The dream whose decisions Seti applies, and what Seti listed for it. */
interface Dream {
  task: Task
  run: Run
  snapshot: ConfigSnapshot
}

/** The agent's subscriptions Seti's rule finds unused, and the list the dream reads. */
export async function configSnapshot(taskId: string, night: string, at = Date.now()): Promise<ConfigSnapshot> {
  const facts = await dreamTidies.subscriptionFacts(taskId, quietSince(at))
  const listed = facts.filter((f) => unused(f, at))
  return {
    items: new Map(listed.map((f) => [`sub-${String(f.id)}`, f])),
    text: configList(night, listed, facts.length - listed.length, at),
  }
}

/** The subscription as it is now, while it is still the agent's and still unused; else why not. */
async function stillUnused(taskId: string, id: number, at: number): Promise<SubscriptionFacts | string> {
  const now = await dreamTidies.subscriptionFact(taskId, id, quietSince(at))
  if (now === undefined) {
    return "it is gone or no longer the agent's"
  }
  return unused(now, at) ? now : 'it delivered since, or the user kept it'
}

/** Unsubscribes the agent and keeps what Undo needs; `dream` marks the audit as the dream's. */
export async function unsubscribeForDream(
  run: Pick<DreamRun, 'id' | 'task_id'>,
  facts: SubscriptionFacts,
  reason: string,
  dream: boolean,
): Promise<DreamTidy> {
  const before = await dreamTidies.before(facts.id)
  if (before === undefined) {
    throw new Error('The subscription is gone')
  }
  const sub = await subscriptions.unsubscribe(facts.channel_id, facts.id)
  await audit.record({
    actor: dream ? 'system' : 'user',
    kind: 'system.channel_unsubscribed',
    subject_type: 'task',
    subject_id: run.task_id,
    summary: `${dream ? 'A dream: ' : ''}Unsubscribed "${sub.task_title ?? ''}" from ${sub.channel_name}`,
    detail: {
      channel: sub.channel_name,
      channel_id: sub.channel_id,
      target: 'task',
      task_id: run.task_id,
      events: sub.events === null ? null : [...sub.events],
      delivery: sub.delivery,
      ...(dream ? { via: 'dream', run: run.id } : {}),
    },
  })
  return dreamTidies.add(run, { label: facts.channel_name, reason, before })
}

/** Checks an unsubscribe proposal again when the user allows it, then applies it with an Undo. */
export async function allowUnsubscribe(run: Pick<DreamRun, 'id' | 'task_id'>, subject: string, reason: string) {
  const now = await stillUnused(run.task_id, Number(subject), Date.now())
  return typeof now === 'string' ? now : unsubscribeForDream(run, now, reason, false)
}

async function propose({ task, run }: Dream, facts: SubscriptionFacts, reason: string): Promise<string | null> {
  if ((await dreamProposals.countForRun(run.id)) >= PROPOSALS_PER_DREAM) {
    return `a dream proposes at most ${String(PROPOSALS_PER_DREAM)} changes`
  }
  const target = facts.channel_name
  const proposal = await dreamProposals.add(run, { kind: 'unsubscribe', target, reason, subject: String(facts.id) }, 0)
  await audit.record({
    actor: 'system',
    kind: 'dream.proposed',
    subject_type: 'task',
    subject_id: task.id,
    summary: `A dream of ${task.title} proposed: unsubscribe from ${target}`,
    detail: { run: run.id, proposal: proposal.id, kind: 'unsubscribe', target },
  })
  return null
}

/** Why Seti will not act on a decision, or the subscription to act on. */
async function check({ task, snapshot }: Dream, decision: DreamConfigDecision, at: number) {
  if (!decision.item.startsWith('sub-')) {
    return 'a dream changes only the subscriptions Seti listed'
  }
  const listed = snapshot.items.get(decision.item)
  if (listed === undefined) {
    return 'it was not in the list Seti gave'
  }
  const now = await stillUnused(task.id, listed.id, at)
  return typeof now === 'string' || sameSubscription(listed, now) ? now : 'it changed during the dream'
}

/** What applying a dream's decisions did: the changes with their Undo, and Seti's own found lines. */
export interface ConfigOutcome {
  applied: DreamTidy[]
  found: string[]
}

/** Acts on one checked decision; why not, or null once it is applied or proposed. */
async function act(dream: Dream, decision: DreamConfigDecision, facts: SubscriptionFacts, out: ConfigOutcome) {
  if (decision.decision === 'propose') {
    return propose(dream, facts, decision.reason)
  }
  if (out.applied.length >= TIDIES_PER_DREAM) {
    return `Seti applies at most ${String(TIDIES_PER_DREAM)} changes a dream`
  }
  out.applied.push(await unsubscribeForDream(dream.run, facts, decision.reason, true))
  return null
}

async function decide(dream: Dream, decisions: readonly DreamConfigDecision[]) {
  const out: ConfigOutcome = { applied: [], found: [] }
  const at = Date.now()
  const firsts = decisions.filter((d, i) => decisions.findIndex((other) => other.item === d.item) === i)
  for (const decision of firsts) {
    const checked = await check(dream, decision, at)
    const refusal = typeof checked === 'string' ? checked : await act(dream, decision, checked, out)
    if (refusal !== null) {
      out.found.push(`Seti: did not ${decision.decision} ${decision.item}: ${refusal}`)
    }
  }
  return out
}

/**
 * Applies a dream's configuration decisions after it ended on its own: each only while Seti
 * listed it, it is still the agent's, unchanged and unused, at most `TIDIES_PER_DREAM`; anything
 * else is refused with a line for the report. A dream cut, stopped or failed changes nothing.
 */
export async function applyConfig(
  dream: Dream,
  decisions: readonly DreamConfigDecision[],
  ended: DreamRun['state'],
): Promise<ConfigOutcome> {
  if (decisions.length === 0) {
    return { applied: [], found: [] }
  }
  if (ended !== 'done') {
    return { applied: [], found: ['Seti: changed no configuration, since the dream did not end on its own'] }
  }
  return decide(dream, decisions)
}
