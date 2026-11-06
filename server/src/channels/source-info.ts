import { sourceMod, type ChannelSources, type PollerTemplateInfo, type WebhookSourceInfo } from '@seti/shared'
import { HttpError } from '../http.js'
import { modWebhookInfo, pollerTemplates, webhookSources, type WebhookSource } from './sources.js'
import { modHost } from '../mods/bundled.js'

/** The sources a new channel can come from now. */
export const channelSources = (): ChannelSources => ({
  webhooks: webhookSources.list().map((source) => source.info),
  pollers: [...pollerTemplates.list()],
})

/** The manifest of the mod a source id names, with the source it declares; null when none does. */
function declaring(id: string, kind: 'webhook' | 'poller') {
  const mod = sourceMod(id)
  const manifest = mod === null ? null : (modHost.get(mod)?.manifest ?? null)
  const local = id.slice((mod?.length ?? 0) + 1)
  const declared = manifest?.contributes.channelSources.find((entry) => entry.kind === kind && entry.id === local)
  return manifest === null || declared === undefined ? null : { manifest, declared }
}

interface Missing {
  status: 400 | 409
  reason: string
  /** What the user does about it, after the reason. */
  remedy: string
}

/** Why a source that is not registered cannot be used: its mod is off, or Seti has no such source. */
function missing(id: string, kind: 'webhook' | 'poller'): Missing {
  const found = declaring(id, kind)
  if (found === null) {
    return {
      status: 400,
      reason: `Seti has no ${kind === 'webhook' ? 'webhook source' : 'poller template'} ${id}`,
      remedy: '',
    }
  }
  const { name } = found.manifest
  const mod = modHost.get(found.manifest.id)
  if (mod?.enabled !== true) {
    return { status: 409, reason: `The ${name} mod is off`, remedy: '; turn it on in Settings, Mods' }
  }
  const why = mod.problem ?? (modHost.heldBySafeMode(mod) ? 'safe mode holds it off' : 'it did not start')
  return { status: 409, reason: `The ${name} mod is not running: ${why}`, remedy: '' }
}

const refusal = ({ status, reason, remedy }: Missing) => new HttpError(status, `${reason}${remedy}`)

/** A webhook's sender, and why it refuses deliveries now; known from its mod's manifest while off. */
export function webhookSender(id: string): { sender: WebhookSourceInfo; unavailable: string | null } {
  const source = webhookSources.get(id)
  if (source !== undefined) {
    return { sender: source.info, unavailable: null }
  }
  const found = declaring(id, 'webhook')
  const sender = found?.declared.kind === 'webhook' ? modWebhookInfo(found.manifest.id, found.declared) : unknown(id)
  return { sender, unavailable: missing(id, 'webhook').reason }
}

const unknown = (id: string): WebhookSourceInfo => ({
  id,
  mod: sourceMod(id),
  label: id,
  description: '',
  signature: '',
  secret: 'generated',
  kinds: [],
  setup: '',
})

/** The registered source a new or tested webhook needs; refused with why when there is none. */
export function requireWebhookSource(id: string): WebhookSource {
  const source = webhookSources.get(id)
  if (source === undefined) {
    throw refusal(missing(id, 'webhook'))
  }
  return source
}

/** The template a new poller starts from; refused with why when it is not available. */
export function requirePollerTemplate(id: string): PollerTemplateInfo {
  const template = pollerTemplates.get(id)
  if (template === undefined) {
    throw refusal(missing(id, 'poller'))
  }
  return template
}

/** A channel's source in a word or two, such as GitHub, Poller or Reminder. */
export function channelSourceLabel(preset: string): string {
  if (preset === 'poller' || preset === 'reminder') {
    return preset === 'poller' ? 'Poller' : 'Reminder'
  }
  return webhookSender(preset).sender.label
}
