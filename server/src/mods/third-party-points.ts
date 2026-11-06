import type { ModCommandCall } from '@seti/mod-api'
import {
  EA_NOTICE_SEVERITIES,
  type Disposer,
  type ModError,
  type ModErrorCode,
  type ModManifest,
  type ModWebhookSource,
} from '@seti/shared'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { z } from 'zod'
import { modWebhookChecks, modWebhookInfo, webhookSources } from '../channels/sources.js'
import type { Parsed } from '../channels/types.js'
import { HttpError } from '../http.js'
import { fireModEvent, runCommandEvent } from './logic/service.js'
import { modCommands } from './points.js'

const STATUS: Readonly<Record<ModErrorCode, ContentfulStatusCode>> = {
  denied: 403,
  invalid: 400,
  limit: 429,
  asked: 409,
  failed: 502,
  busy: 429,
}

/** A failed event as the caller reads it, naming the mod and the command. */
const commandError = (manifest: ModManifest, command: string, error: ModError) =>
  new HttpError(STATUS[error.code], `${manifest.name}: ${command} failed: ${error.message}`)

const originOf = ({ source, agent }: ModCommandCall['caller']) =>
  source === 'agent' && agent !== null ? { caller: 'agent' as const, agentId: agent } : { caller: source }

/** Answers each command the manifest declares by running it as an onCommand event in the pool. */
function registerCommands(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const command of manifest.contributes.commands) {
    track(
      modCommands.register({
        mod: manifest.id,
        modName: manifest.name,
        command,
        run: async ({ args, caller }) => {
          const result = await runCommandEvent(manifest.id, command.id, args, originOf(caller))
          if (!result.ok) {
            throw commandError(manifest, command.id, result.error)
          }
          return result.value
        },
      }),
    )
  }
}

/** What onWebhook returns: one event for the channel, or null to ignore the delivery. */
const webhookItem = z
  .strictObject({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(2000).default(''),
    url: z
      .string()
      .max(2000)
      .regex(/^https?:\/\//i, 'A link is an http or https URL')
      .nullable()
      .default(null),
    kind: z.string().max(80).optional(),
    severity: z.enum(EA_NOTICE_SEVERITIES).default('info'),
  })
  .nullable()

/** Headers a mod's handler may read: none that carry the signature or a credential. */
const SECRET_HEADER = /signature|token|secret|auth|cookie|key|pass|hmac|credential|session|(?:sig$)/i

function forwarded(headers: Headers, declared: ModWebhookSource): Record<string, string> {
  const kept: Record<string, string> = {}
  for (const [name, value] of headers) {
    const wanted = name === 'content-type' || name === 'user-agent' || name.startsWith('x-')
    if (wanted && !SECRET_HEADER.test(name) && name !== declared.signature.header.toLowerCase()) {
      kept[name] = value.slice(0, 4000)
    }
  }
  return kept
}

/** The test button's delivery; Seti signs it like a real one. */
const TEST_SAMPLE = () => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ seti: 'Test event from Seti' }),
})

/** Reads a verified delivery in the mod's logic, as an onWebhook event. */
async function parseByLogic(
  manifest: ModManifest,
  declared: ModWebhookSource,
  payload: unknown,
  headers: Headers,
): Promise<Parsed> {
  const event = {
    kind: 'webhook' as const,
    sourceId: declared.id,
    headers: forwarded(headers, declared),
    body: JSON.stringify(payload),
    receivedAt: new Date().toISOString(),
  }
  const result = await fireModEvent(manifest.id, event, { caller: 'webhook' })
  if (!result.ok) {
    const reason = `the ${manifest.name} mod did not read it: ${result.error.message}`
    return { kind: result.error.code === 'busy' ? 'busy' : 'ignore', reason } satisfies Parsed
  }
  const item = webhookItem.safeParse(result.value ?? null)
  if (!item.success) {
    return {
      kind: 'ignore',
      reason: `the ${manifest.name} mod returned something that is not an event`,
    } satisfies Parsed
  }
  if (item.data === null) {
    return { kind: 'ignore', reason: `the ${manifest.name} mod ignored it` } satisfies Parsed
  }
  const { title, body, url, kind, severity } = item.data
  const fields = { source: manifest.name, severity, title, detail: body, url, occurred_at: event.receivedAt }
  return { kind: 'event', fields: kind === undefined ? fields : { ...fields, kind } } satisfies Parsed
}

/** Offers each webhook source the manifest declares; Seti verifies, the mod's logic reads. */
function registerWebhooks(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const declared of manifest.contributes.channelSources) {
    if (declared.kind === 'webhook') {
      const adapter = {
        ...modWebhookChecks(declared, TEST_SAMPLE),
        parse: async (payload: unknown, headers: Headers) => parseByLogic(manifest, declared, payload, headers),
      }
      track(webhookSources.register({ info: modWebhookInfo(manifest.id, declared), adapter }))
    }
  }
}

/** The commands and webhook sources of a third-party mod, all answered by its logic. */
export function registerLogicPoints(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  registerCommands(manifest, track)
  registerWebhooks(manifest, track)
}
