import type { WebhookChannelInfo, webhookFilterInput } from '@seti/shared'
import type { z } from 'zod'
import { audit } from '../audit.js'
import { now } from '../db.js'
import { filterWorkers } from './filter-run.js'
import { webhooks } from './service.js'
import { sha256Hex } from './signature.js'
import { webhookFilterStore, type WebhookFilterRecord } from '../store/webhook-filters.js'

const codeHash = (script: string) => `sha256:${sha256Hex(script)}`

const lines = (script: string) => script.split('\n').length

function summaryOf(name: string, before: WebhookFilterRecord | null, after: WebhookFilterRecord | null): string {
  if (after === null) {
    return `Removed the filter of the webhook ${name}`
  }
  const state = after.enabled ? 'on' : 'off'
  if (before?.script !== after.script) {
    return `Set the filter of the webhook ${name} to ${String(lines(after.script))} lines of code, ${state}`
  }
  return `Changed the filter of the webhook ${name}: ${state}, on error ${after.on_error}`
}

/** Starts a filter worker ahead of the first delivery when any webhook has a filter on. */
export function warmFilters(): void {
  webhookFilterStore.anyEnabled().then(
    (any) => {
      if (any) {
        filterWorkers.warm()
      }
    },
    (e: unknown) => {
      process.stderr.write(`channels: could not check for webhook filters: ${String(e)}\n`)
    },
  )
}

type Saved = WebhookFilterRecord | null

const sameFilter = (a: Saved, b: Saved) =>
  a?.script === b?.script && a?.enabled === b?.enabled && a?.on_error === b?.on_error

const auditDetail = (name: string, before: Saved, after: Saved) => ({
  channel: name,
  code: after === null ? null : codeHash(after.script),
  previous_code: before === null ? null : codeHash(before.script),
  lines: after === null ? 0 : lines(after.script),
  enabled: after?.enabled ?? false,
  on_error: after?.on_error ?? null,
})

/**
 * Saves, changes or removes a webhook's filter, as poller scripts are: the user, the EA behind
 * its confirmation and agents at Full control may. The audit keeps a hash of the code, not code.
 */
export async function setWebhookFilter(
  id: string,
  input: z.output<typeof webhookFilterInput>,
): Promise<WebhookChannelInfo> {
  const { name } = await webhooks.info(id)
  const before = (await webhookFilterStore.get(id)) ?? null
  if (input.script.trim() === '') {
    await webhookFilterStore.remove(id)
  } else {
    await webhookFilterStore.save(id, input, now())
  }
  const after = input.script.trim() === '' ? null : ((await webhookFilterStore.get(id)) ?? null)
  if (!sameFilter(before, after)) {
    await audit.record({
      actor: 'user',
      kind: 'system.webhook_filter_changed',
      subject_type: 'system',
      subject_id: id,
      summary: summaryOf(name, before, after),
      detail: auditDetail(name, before, after),
    })
  }
  if (after?.enabled === true) {
    filterWorkers.warm()
  }
  return webhooks.info(id)
}
