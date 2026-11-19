import { z } from 'zod'
import { webhookSenderById } from './webhook-sender-catalog.js'
import { CUSTOM_WEBHOOK_SOURCE } from './webhook-senders.js'

/** The webhook source every Seti has: any JSON sender that signs or sends a bearer secret. */
export const CORE_WEBHOOK_SOURCE = 'generic'

/** The poller template every Seti has: an empty poll function. */
export const CORE_POLLER_TEMPLATE = 'blank'

/** Ids from before these sources moved into mods; older callers still send them. */
const WEBHOOK_SOURCE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['github', 'github-webhooks.github'],
  ['sentry', 'sentry-webhooks.sentry'],
])

const POLLER_TEMPLATE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['http_json', 'poller-templates.http_json'],
  ['feed', 'poller-templates.feed'],
])

/** `<mod>.<id>`: a source a mod adds, named as everything a mod adds is. */
const MOD_SOURCE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/

/** The mod that adds a source, from its id; null for Seti's own. */
export const sourceMod = (id: string): string | null => (MOD_SOURCE.test(id) ? (id.split('.')[0] ?? null) : null)

const sourceId = (
  core: string,
  aliases: ReadonlyMap<string, string>,
  what: string,
  listed: (id: string) => boolean = () => false,
) =>
  z
    .string()
    .trim()
    .max(82)
    .transform((id) => aliases.get(id) ?? id)
    .refine((id) => id === core || MOD_SOURCE.test(id) || listed(id), `A ${what} is ${core} or a mod's <mod>.<id>`)

/** Whether an id names a sender described as data: one of the catalog, or the user's own. */
export const isDataSender = (id: string): boolean => id === CUSTOM_WEBHOOK_SOURCE || webhookSenderById(id) !== undefined

/**
 * A webhook source as a request names it: the core one, a catalog sender such as linear, custom,
 * a mod's, or an id from before mods.
 */
export const webhookSourceId = sourceId(CORE_WEBHOOK_SOURCE, WEBHOOK_SOURCE_ALIASES, 'webhook source', isDataSender)

/** A poller template as a request names it: the core one, a mod's, or an id from before mods. */
export const pollerTemplateId = sourceId(CORE_POLLER_TEMPLATE, POLLER_TEMPLATE_ALIASES, 'poller template')

/** generated: Seti makes the secret; sender: the sender issues it and the user pastes it in. */
export type ChannelSecretSource = 'generated' | 'sender'

/** A kind of sender a webhook can take, from Seti or from a mod. */
export interface WebhookSourceInfo {
  id: string
  /** The mod that adds it; null for Seti's own. */
  mod: string | null
  label: string
  description: string
  /** The header the sender signs with. */
  signature: string
  secret: ChannelSecretSource
  /** Event kinds this sender reports, offered when filtering a subscription. */
  kinds: string[]
  /** How to point the sender at the webhook. */
  setup: string
  /** The brand mark beside its name, when the UI draws one for it. */
  icon: string | null
  /** What the sender calls the secret, such as Signing secret. */
  secret_label: string
  /** The setup as short steps, for a sender that lists them; empty otherwise. */
  steps: string[]
}

/** A script a new poller can start from, from Seti or from a mod. */
export interface PollerTemplateInfo {
  id: string
  mod: string | null
  label: string
  description: string
  script: string
}

/** The sources a new channel can come from now: Seti's own and those of mods that are on. */
export interface ChannelSources {
  webhooks: WebhookSourceInfo[]
  pollers: PollerTemplateInfo[]
}
