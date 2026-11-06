import {
  POLLER_SECURITY_FIELDS,
  type PollerChange,
  type PollerChannelInfo,
  type pollerCreateInput,
  type PollerSettings,
  type pollerTestInput,
  type PollerTestResult,
} from '@seti/shared'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { requirePollerTemplate } from '../channels/source-info.js'
import { refuseAgent } from '../ea-guard.js'
import { pollers } from './service.js'
import type { PollerRecord } from '../store/pollers.js'

const REACH = "change a poller's extra hosts or secrets"
const SECRET_SCRIPT = 'change the script of a poller that uses secrets'

type Security = Pick<PollerSettings, (typeof POLLER_SECURITY_FIELDS)[number]>

const same = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

/** Whether settings reach further than the saved poller, or than a new one with none of either. */
const reachesFurther = (given: PollerChange, saved: Security) =>
  POLLER_SECURITY_FIELDS.some((field) => given[field] !== undefined && !same(given[field], saved[field]))

const NONE: Security = { extra_hosts: [], secrets: [] }

/**
 * What only the user may do to a poller, refused to the EA and to agents: widen its reach, or
 * rewrite a script that sends secrets. Null when the change may go ahead.
 */
export function pollerRefusal(given: PollerChange, saved: PollerRecord | undefined): string | null {
  if (reachesFurther(given, saved ?? NONE)) {
    return REACH
  }
  const script = given.script
  if (saved !== undefined && saved.secrets.length > 0 && script !== undefined && script !== saved.script) {
    return SECRET_SCRIPT
  }
  return null
}

function refuseAgentChange(given: PollerChange, saved: PollerRecord | undefined): void {
  const refusal = pollerRefusal(given, saved)
  if (refusal !== null) {
    refuseAgent(refusal)
  }
}

const CHANGE_FIELDS = [
  'name',
  'script',
  'interval_s',
  'timeout_s',
  'extra_hosts',
  'secrets',
  'fingerprint_fields',
  'detect_gone',
  'enabled',
] as const

export async function createPoller(input: z.output<typeof pollerCreateInput>): Promise<PollerChannelInfo> {
  refuseAgentChange(input, undefined)
  requirePollerTemplate(input.preset)
  const created = await pollers.create(input)
  await audit.record({
    actor: 'user',
    kind: 'system.channel_created',
    subject_type: 'system',
    subject_id: created.id,
    summary: `Created the poller ${created.name}`,
    detail: {
      channel: created.name,
      preset: 'poller',
      template: input.preset,
      interval_s: input.interval_s,
      secrets: [...input.secrets],
      extra_hosts: [...input.extra_hosts],
      subscribe_ea: input.subscribe_ea,
    },
  })
  return created
}

/** Runs a script once without storing or reporting anything, with a saved poller's state if named. */
export async function testPoller(input: z.output<typeof pollerTestInput>): Promise<PollerTestResult> {
  refuseAgentChange(input, input.channel_id === undefined ? undefined : await pollers.get(input.channel_id))
  return pollers.test(input)
}

export async function updatePoller(id: string, change: PollerChange): Promise<PollerChannelInfo> {
  const before = await pollers.get(id)
  refuseAgentChange(change, before)
  if (change.preset !== undefined && change.preset !== before.preset) {
    requirePollerTemplate(change.preset)
  }
  const after = await pollers.update(id, change)
  const saved = { ...after.poller, name: after.name }
  const changed = CHANGE_FIELDS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(saved[key]))
  if (changed.length > 0) {
    await audit.record({
      actor: 'user',
      kind: 'system.channel_changed',
      subject_type: 'system',
      subject_id: id,
      summary: `Changed the poller ${after.name}: ${changed.join(', ')}`,
      detail: {
        channel: after.name,
        changed: [...changed],
        secrets: [...after.poller.secrets],
        extra_hosts: [...after.poller.extra_hosts],
      },
    })
  }
  return after
}

export async function pollNow(id: string): Promise<PollerChannelInfo> {
  const polled = await pollers.pollNow(id)
  const last = polled.poller.runs[0]
  const outcome = last?.ok === false ? `failed, ${last.error ?? ''}` : `${String(last?.emitted ?? 0)} events`
  await audit.record({
    actor: 'user',
    kind: 'system.channel_polled',
    subject_type: 'system',
    subject_id: polled.id,
    summary: `Polled ${polled.name} now: ${outcome}`,
    detail: { channel: polled.name, ok: last?.ok ?? null, items: last?.items ?? 0, emitted: last?.emitted ?? 0 },
  })
  return polled
}
