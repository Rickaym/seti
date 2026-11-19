import { CUSTOM_WEBHOOK_SOURCE, senderHeader, type SenderDefinition, type WebhookSourceInfo } from '@seti/shared'
import { senderAdapter } from './sender-adapter.js'
import { webhookSender } from './source-info.js'
import { webhookSources, type WebhookSource } from './sources.js'

const CUSTOM_SETUP = {
  hmac: 'The app posts JSON to the URL and signs each request as this webhook describes, keyed with the secret.',
  token: 'The app posts JSON to the URL and sends the secret in the header this webhook names.',
} as const

/** A sender the user described, as the user reads it. */
const customInfo = (definition: SenderDefinition): WebhookSourceInfo => ({
  id: CUSTOM_WEBHOOK_SOURCE,
  mod: null,
  label: 'Custom',
  description: 'An app described by its signature header and fields.',
  signature: senderHeader(definition),
  secret: definition.secret,
  kinds: [],
  setup: CUSTOM_SETUP[definition.signature.scheme],
  icon: null,
  secret_label: 'Secret',
  steps: [],
})

/** What names a channel's sender: its source id and, for a custom one, its own definition. */
export interface SenderOf {
  name: string
  preset: string
  sender: SenderDefinition | null
}

/** The source that verifies and reads a channel now; undefined while none does. */
export function channelSource(channel: SenderOf): WebhookSource | undefined {
  if (channel.preset !== CUSTOM_WEBHOOK_SOURCE) {
    return webhookSources.get(channel.preset)
  }
  const definition = channel.sender
  return definition === null
    ? undefined
    : { info: customInfo(definition), adapter: senderAdapter(channel.name, definition) }
}

/** A channel's sender as the user reads it, and why it refuses deliveries now. */
export function channelSender(channel: SenderOf): { sender: WebhookSourceInfo; unavailable: string | null } {
  const source = channel.preset === CUSTOM_WEBHOOK_SOURCE ? channelSource(channel) : undefined
  return source === undefined ? webhookSender(channel.preset) : { sender: source.info, unavailable: null }
}
