import { defineMod } from '@seti/mod-api'
import {
  channelCreateInput,
  pollerCreateInput,
  type ChannelSecret,
  type ChannelSources,
  type WebhookChannelInfo,
} from '@seti/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { hmacHex } from './signature.js'
import { pollerTemplates, webhookSources } from './sources.js'
import { createApp } from '../app.js'
import { ModHost } from '../mods/host.js'
import { channelStore } from '../store/channels.js'
import { USER_AUTH } from '../test-auth.js'
import { migrateWith } from '../test-migration.js'
import { withBundledMods } from '../test-mods.js'

withBundledMods()

const app = createApp()
const GITHUB = 'github-webhooks.github'
const SENTRY_SOURCE = 'sentry-webhooks.sentry'
const SENTRY = ['sentry', 'client', 'secret', 'for', 'tests'].join('-')

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
const api = async <T>(method: string, path: string, body?: unknown) => {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, data: (JSON.parse(text) as { data: T }).data, error: text }
}

const setMod = async (id: string, enabled: boolean) => {
  const res = await api('PATCH', `/mods/${id}`, { enabled })
  expect(res.status, res.error).toBe(200)
}

afterEach(async () => {
  await setMod('sentry-webhooks', true)
})

const sentryDelivery = async (path: string, secret: string | null, nonce: string): Promise<number> => {
  const body = JSON.stringify({ action: 'triggered', data: { event: { title: 'Boom', level: 'error' } } })
  const signature = secret === null ? {} : { 'sentry-hook-signature': hmacHex(secret, body) }
  const res = await app.request(path, {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3006',
      'content-type': 'application/json',
      'sentry-hook-resource': 'event_alert',
      'request-id': nonce,
      ...signature,
    },
    body,
  })
  return res.status
}

describe('channel sources', () => {
  it("lists Seti's own sources first, then those of the bundled mods", async () => {
    const { data } = await api<ChannelSources>('GET', '/channels/sources')
    expect(data.webhooks.map((source) => [source.id, source.mod, source.label])).toEqual([
      ['generic', null, 'Generic'],
      [GITHUB, 'github-webhooks', 'GitHub'],
      ['sentry-webhooks.sentry', 'sentry-webhooks', 'Sentry'],
    ])
    expect(data.pollers.map((template) => template.id)).toEqual([
      'blank',
      'poller-templates.http_json',
      'poller-templates.feed',
    ])
    expect(data.webhooks[1]).toMatchObject({ signature: 'X-Hub-Signature-256', secret: 'generated' })
    expect(data.webhooks[2]).toMatchObject({ signature: 'Sentry-Hook-Signature', secret: 'sender' })
  })

  it('reads the ids from before mods as the ids of the mods that took them over', () => {
    const preset = (given: string) => channelCreateInput.parse({ name: 'x', preset: given }).preset
    expect(preset('github')).toBe(GITHUB)
    expect(preset('sentry')).toBe('sentry-webhooks.sentry')
    expect(preset('generic')).toBe('generic')
    expect(preset('acme-hooks.acme')).toBe('acme-hooks.acme')
    expect(channelCreateInput.safeParse({ name: 'x', preset: 'Acme' }).success).toBe(false)
    expect(channelCreateInput.safeParse({ name: 'x', preset: 'constructor' }).success).toBe(false)
    const template = (given: string) => pollerCreateInput.parse({ name: 'x', script: 'x', preset: given }).preset
    expect(template('http_json')).toBe('poller-templates.http_json')
    expect(template('feed')).toBe('poller-templates.feed')
    expect(template('blank')).toBe('blank')
  })

  it('migrates stored ids to the ids of the mods', async () => {
    const at = '2026-11-01T00:00:00.000Z'
    const seed = `
      INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at) VALUES
        ('gh', 'GH', 'github', 'plain', '{}', '${at}', '${at}'),
        ('se', 'SE', 'sentry', 'plain', '{}', '${at}', '${at}'),
        ('ge', 'GE', 'generic', 'plain', '{}', '${at}', '${at}');
      INSERT INTO channel (id, name, preset, secret, mapping, created_at, updated_at, source) VALUES
        ('p1', 'P1', 'poller', NULL, '{}', '${at}', '${at}', 'poller'),
        ('p2', 'P2', 'poller', NULL, '{}', '${at}', '${at}', 'poller');
      INSERT INTO channel_poller (channel_id, script, preset, interval_s, timeout_s) VALUES
        ('p1', 'x', 'http_json', 60, 5), ('p2', 'x', 'blank', 60, 5);`
    const outcome = await migrateWith('channel_source_mods', seed, async (tx) => ({
      channels: await tx<{ id: string; preset: string }[]>`SELECT id, preset FROM channel ORDER BY id`,
      pollers: await tx<{ id: string; preset: string }[]>`SELECT channel_id AS id, preset FROM channel_poller
        ORDER BY channel_id`,
    }))
    expect(outcome.channels).toEqual([
      { id: 'ge', preset: 'generic' },
      { id: 'gh', preset: GITHUB },
      { id: 'p1', preset: 'poller' },
      { id: 'p2', preset: 'poller' },
      { id: 'se', preset: 'sentry-webhooks.sentry' },
    ])
    expect(outcome.pollers).toEqual([
      { id: 'p1', preset: 'poller-templates.http_json' },
      { id: 'p2', preset: 'blank' },
    ])
  })
})

describe('a webhook whose mod is off', () => {
  it('refuses every delivery with why, unsigned ones too, and takes them again once the mod is on', async () => {
    const created = await api<ChannelSecret>('POST', '/channels', { name: 'Alerts', preset: 'sentry', secret: SENTRY })
    expect(created.status, created.error).toBe(200)
    const { channel } = created.data
    expect(channel).toMatchObject({ preset: SENTRY_SOURCE, unavailable: null, sender: { label: 'Sentry' } })

    await setMod('sentry-webhooks', false)
    expect(webhookSources.has(SENTRY_SOURCE)).toBe(false)
    expect(await sentryDelivery(channel.path, SENTRY, 'off-1')).toBe(503)
    expect(await sentryDelivery(channel.path, null, 'off-2')).toBe(503)
    const info = await api<WebhookChannelInfo[]>('GET', '/channels')
    const card = info.data.find((entry) => entry.id === channel.id)
    expect(card).toMatchObject({ unavailable: 'The Sentry webhooks mod is off', sender: { label: 'Sentry' } })
    expect(card?.deliveries[0]).toMatchObject({ status: 'rejected', reason: 'The Sentry webhooks mod is off' })
    expect(await channelStore.recent(channel.id, 5)).toEqual([])
    const sources = await api<ChannelSources>('GET', '/channels/sources')
    expect(sources.data.webhooks.map((source) => source.id)).toEqual(['generic', GITHUB])
    const refused = await api('POST', '/channels', { name: 'Another', preset: 'sentry', secret: SENTRY })
    expect(refused.status).toBe(409)
    expect(refused.error).toContain('The Sentry webhooks mod is off; turn it on in Settings, Mods')
    expect((await api('POST', `/channels/${channel.id}/test`)).status).toBe(409)

    await setMod('sentry-webhooks', true)
    expect(await sentryDelivery(channel.path, null, 'on-1')).toBe(401)
    expect(await sentryDelivery(channel.path, `${SENTRY}x`, 'on-2')).toBe(401)
    expect(await sentryDelivery(channel.path, SENTRY, 'on-3')).toBe(200)
    expect(await channelStore.recent(channel.id, 5)).toHaveLength(1)
    const after = await api<WebhookChannelInfo[]>('GET', '/channels')
    expect(after.data.find((entry) => entry.id === channel.id)?.unavailable).toBeNull()
  })
})

describe('required source mods', () => {
  it('keep GitHub webhooks and poller templates on, refusing to turn them off', async () => {
    for (const id of ['github-webhooks', 'poller-templates']) {
      const refused = await api('PATCH', `/mods/${id}`, { enabled: false })
      expect(refused.status).toBe(409)
      expect(refused.error).toContain('is part of Seti and always on')
    }
    expect(webhookSources.has(GITHUB)).toBe(true)
    expect(pollerTemplates.list().map((template) => template.id)).toEqual([
      'blank',
      'poller-templates.http_json',
      'poller-templates.feed',
    ])
  })
})

describe('the mod API for channel sources', () => {
  const manifest = (channelSources: unknown[]) => ({
    id: 'probe-hooks',
    name: 'Probe hooks',
    version: '1.0.0',
    seti: '^1.0',
    description: 'A mod the tests build',
    contributes: { channelSources },
  })
  const probe = {
    id: 'probe',
    kind: 'webhook',
    title: 'Probe',
    description: 'A probe',
    signature: { header: 'X-Probe-Signature' },
    secret: 'generated',
    setup: 'Point it here.',
  }
  const hosts: ModHost[] = []
  afterEach(() => {
    for (const host of hosts.splice(0)) {
      host.stopAll()
    }
  })
  const hostOf = (definition: ReturnType<typeof defineMod>) => {
    const host = new ModHost([{ definition, tier: 'bundled' }])
    hosts.push(host)
    return host
  }

  it('verifies with the declared header before the mod parses, and never hands the mod the secret', async () => {
    const parsed: unknown[] = []
    const host = hostOf(
      defineMod({
        manifest: manifest([probe]),
        server: (modApi) => {
          modApi.registerWebhookSource('probe', {
            parse: (payload) => {
              parsed.push(payload)
              return { kind: 'ignore', reason: 'probe' }
            },
            sample: () => ({ headers: { 'x-probe-signature': 'forged' }, body: '{"probe":true}' }),
          })
        },
      }),
    )
    await host.setEnabled('probe-hooks', true)
    const adapter = webhookSources.get('probe-hooks.probe')?.adapter
    if (adapter === undefined) {
      throw new Error('the probe source is not registered')
    }
    const sample = adapter.sample('secret-1', 'nonce-1')
    expect(sample.headers['x-probe-signature']).toBe(hmacHex('secret-1', sample.body))
    const request = { headers: new Headers(sample.headers), body: Buffer.from(sample.body) }
    expect(adapter.verify(request, 'secret-1')).toEqual({ ok: true })
    expect(adapter.verify(request, 'secret-2')).toEqual({ ok: false, reason: 'signature mismatch' })
    expect(adapter.verify({ headers: new Headers(), body: request.body }, 'secret-1')).toEqual({
      ok: false,
      reason: 'missing signature',
    })
    expect(parsed).toEqual([])
    await host.setEnabled('probe-hooks', false)
    expect(webhookSources.has('probe-hooks.probe')).toBe(false)
  })

  it('keeps a mod off that declares a source it does not register, or registers one it did not declare', async () => {
    const silent = hostOf(defineMod({ manifest: manifest([probe]), server: () => undefined }))
    await expect(silent.setEnabled('probe-hooks', true)).rejects.toThrow(
      'It declares the channel source probe, which its server half does not register',
    )
    expect(webhookSources.has('probe-hooks.probe')).toBe(false)
    const stray = hostOf(
      defineMod({
        manifest: manifest([]),
        server: (modApi) => {
          modApi.registerPollerTemplate('stray', { script: '' })
        },
      }),
    )
    await expect(stray.setEnabled('probe-hooks', true)).rejects.toThrow('which its manifest does not declare')
  })
})
