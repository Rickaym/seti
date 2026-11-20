import {
  WEBHOOK_FILTER_LIMITS,
  webhookFilterInput,
  webhookFilterTestInput,
  type WebhookChannelInfo,
} from '@seti/shared'
import { z } from 'zod'
import { ToolRefusal } from './tool.js'
import { setWebhookFilter } from '../channels/filter-actions.js'
import { testFilter } from '../channels/filter-test.js'

const FILTER_API =
  'export default function filter(event, { log }) gets { event, action, title, link, detail, headers, payload } ' +
  'and returns null or false to drop the delivery, true to keep it, or an object replacing any of event, ' +
  'title, link and detail. It may be async, and runs in an isolated engine with no network or files, in ' +
  `${String(WEBHOOK_FILTER_LIMITS.memoryMb)} MB and ${String(WEBHOOK_FILTER_LIMITS.timeoutMs / 1000)} s. ` +
  'A filter that throws, times out or returns anything else keeps the delivery unchanged.'

export const filterArgs = {
  filter: z
    .string()
    .max(WEBHOOK_FILTER_LIMITS.scriptMaxChars)
    .optional()
    .describe(`Webhooks only: the whole filter code, which turns it on; an empty string removes it. ${FILTER_API}`),
  filter_enabled: z.boolean().optional().describe("Webhooks only: false turns the webhook's filter off, true on."),
}

export interface FilterArgs {
  filter?: string | undefined
  filter_enabled?: boolean | undefined
}

export const hasFilterArgs = (args: FilterArgs) => args.filter !== undefined || args.filter_enabled !== undefined

type FilterInfo = WebhookChannelInfo['filter']

/** The filter the arguments ask for, from the webhook's current one; new code turns it on. */
function nextFilter(info: WebhookChannelInfo, args: FilterArgs) {
  const current: FilterInfo = info.filter
  const script = args.filter ?? current?.script
  if (script === undefined) {
    throw new ToolRefusal(`${info.name} has no filter yet: give its code with filter.`)
  }
  const removing = script.trim() === ''
  const turnedOn = args.filter === undefined ? (current?.enabled ?? true) : true
  return webhookFilterInput.parse({
    script,
    enabled: removing ? false : (args.filter_enabled ?? turnedOn),
  })
}

/** Applies the filter arguments to a webhook's filter; false when they change nothing. */
export async function changeFilter(info: WebhookChannelInfo, args: FilterArgs): Promise<boolean> {
  const next = nextFilter(info, args)
  const current = info.filter
  const unchanged =
    current === null ? next.script.trim() === '' : current.script === next.script && current.enabled === next.enabled
  if (unchanged) {
    return false
  }
  await setWebhookFilter(info.id, next)
  return true
}

export const filterSample = z
  .string()
  .max(WEBHOOK_FILTER_LIMITS.sampleMaxChars)
  .optional()
  .describe('Filters only: a request body to try besides the recent deliveries, as the sender sends it.')

/** Tests a draft filter, or the webhook's saved one, against its recent deliveries and a sample. */
export async function testWebhookFilter(info: WebhookChannelInfo, draft: string | undefined, sample?: string) {
  const script = draft ?? info.filter?.script
  if (script === undefined) {
    throw new ToolRefusal(`${info.name} has no filter: give the code to test.`)
  }
  const input = webhookFilterTestInput.parse({ script, ...(sample === undefined ? {} : { sample: { body: sample } }) })
  return testFilter(info.id, input)
}
