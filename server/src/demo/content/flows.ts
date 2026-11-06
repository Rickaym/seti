import { createHmac } from 'node:crypto'
import type { ChannelSecret, EaLlmMessage } from '@seti/shared'
import { CHANNELS, EA_CHAT } from './cast.js'

/** Seti's API as the seed reaches it; the README screenshots and the demo each bring one. */
export interface SeedApi {
  /** Calls a route as the user, or as the EA with `asEa`; resolves with the response's data. */
  call: (method: 'GET' | 'POST', path: string, body?: unknown, asEa?: boolean) => Promise<unknown>
  /** Delivers a signed webhook to a channel's public path. */
  deliver: (path: string, body: string, signature: string) => Promise<void>
}

/** The EA's chat history, written as the EA writes it. */
export async function seedEaChat(api: SeedApi): Promise<void> {
  const entries = EA_CHAT.map((message) => ({ kind: 'chat', message: message as EaLlmMessage }))
  await api.call('POST', '/api/ea/history/messages', { entries }, true)
}

/** Two webhook channels the EA follows, their signed deliveries already relayed to its chat. */
export async function seedChannels(api: SeedApi): Promise<void> {
  for (const channel of CHANNELS) {
    const input = { name: channel.name, preset: channel.preset, subscribe_ea: true }
    const { channel: created, secret } = (await api.call('POST', '/api/channels', input)) as ChannelSecret
    for (const title of channel.events) {
      const body = JSON.stringify({ title, severity: title.includes('rolled back') ? 'critical' : 'info' })
      const signature = `sha256=${createHmac('sha256', secret ?? '')
        .update(body)
        .digest('hex')}`
      await api.deliver(created.path, body, signature)
    }
  }
  const due = (await api.call('GET', '/api/ea/inbox/due', undefined, true)) as { id: number }[]
  await api.call('POST', '/api/ea/inbox/deliver', { ids: due.map((item) => item.id), via: 'chat' }, true)
  await api.call('POST', '/api/ea/inbox/read', {})
}
