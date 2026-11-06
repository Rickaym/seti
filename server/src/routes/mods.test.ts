import type { ModDetail, ModList } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../app.js'
import { modHost } from '../mods/bundled.js'
import { auditEvents } from '../store/audit.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'

const app = createApp()

const request = async (route: string, method = 'GET', body?: unknown, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api${route}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function data<T>(route: string, method = 'GET', body?: unknown, auth?: Record<string, string>): Promise<T> {
  const res = await request(route, method, body, auth)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

afterAll(() => {
  modHost.stopAll()
})

describe('Settings, Mods', () => {
  it('lists each mod with its display name and icon, and its page with its README and changelog', async () => {
    const list = await data<ModList>('/mods')
    expect(list.mods.find((mod) => mod.id === 'previews')).toMatchObject({
      name: 'Previews',
      display_name: 'Previews',
      icon: { kind: 'lucide', name: 'eye' },
    })
    const detail = await data<ModDetail>('/mods/weather')
    expect(detail.readme).toMatch(/^# Weather\n/)
    expect(detail.changelog).toMatch(/^# Changelog\n/)
  })

  it('lists the sample off, with its capabilities in plain words', async () => {
    const list = await data<ModList>('/mods')
    expect(list.safe_mode).toBe(false)
    expect(list.mods.find((mod) => mod.id === 'catppuccin')).toMatchObject({
      tier: 'theme',
      capabilities: [],
      points: ['themes'],
      problem: null,
    })
    expect(list.mods.filter((mod) => mod.tier !== 'theme').map((mod) => mod.id)).toEqual([
      'blobs',
      'github-webhooks',
      'grid',
      'html-preview',
      'poller-templates',
      'pr-previews',
      'previews',
      'sentry-webhooks',
      'side-chat',
      'twemoji',
      'vim',
      'weather',
      'whats-new',
      'sample',
      'view-test',
    ])
    expect(list.mods.filter((mod) => mod.id === 'sample')).toEqual([
      expect.objectContaining({
        id: 'sample',
        tier: 'bundled',
        enabled: false,
        running: false,
        restart: false,
        problem: null,
        capabilities: ['Keeps up to 1 MB of its own data in Seti.', 'Sends you notifications: Sample hello.'],
        notifications: [
          { id: 'hello', title: 'Sample hello', description: 'When the sample says hello', enabled: true },
        ],
      }),
    ])
  })

  it('turns a mod on and off at runtime, serving its routes only while on, and audits each change', async () => {
    expect((await request('/mods/sample/hello')).status).toBe(404)
    expect((await data<ModDetail>('/mods/sample', 'PATCH', { enabled: true })).running).toBe(true)
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.enabled')).toMatchObject({ actor: 'user', subject_id: 'sample' })
    expect(await data('/mods/sample/hello')).toEqual({ text: 'Hello' })
    expect(await data('/mods/sample/count', 'POST', {})).toEqual({ count: 1 })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.sample.counted')).toMatchObject({
      actor: 'mod:sample',
      summary: 'The sample counted to 1',
      detail: { count: 1, via: 'mod', mod: 'sample' },
    })
    const saved = await data<ModDetail>('/mods/sample', 'PATCH', {
      settings: { greeting: 'Hi there', loud: true },
      notifications: { hello: false },
    })
    expect(saved.settings.map((entry) => entry.value)).toEqual(['Hi there', true])
    expect(saved.notifications[0]?.enabled).toBe(false)
    expect(await data('/mods/sample/hello')).toEqual({ text: 'HI THERE' })
    await auditEvents.settled()
    expect((await auditEvents.latest('mod.settings_changed'))?.detail).toMatchObject({
      keys: ['greeting', 'loud', 'notifications.hello'],
    })
    await data('/mods/sample', 'PATCH', { enabled: false })
    expect((await request('/mods/sample/hello')).status).toBe(404)
  })

  it('refuses settings the manifest does not declare or allow', async () => {
    expect((await request('/mods/sample', 'PATCH', { settings: { greeting: 5 } })).status).toBe(400)
    expect((await request('/mods/sample', 'PATCH', { settings: { colour: 'red' } })).status).toBe(400)
    expect((await request('/mods/sample', 'PATCH', { notifications: { nope: true } })).status).toBe(400)
    expect((await request('/mods/nothing', 'PATCH', { enabled: true })).status).toBe(404)
  })

  it('lets the EA turn an ordinary bundled mod on, and keeps safe mode the user alone', async () => {
    expect((await data<ModDetail>('/mods/sample', 'PATCH', { enabled: true }, EA_AUTH)).enabled).toBe(true)
    await auditEvents.settled()
    expect((await auditEvents.latest('mod.enabled'))?.detail).toMatchObject({ via: 'ea' })
    await data('/mods/sample', 'PATCH', { enabled: false }, EA_AUTH)
    const refused = await request('/mods', 'PUT', { safe_mode: true }, EA_AUTH)
    expect(refused.status).toBe(403)
    const safe = await data<ModList>('/mods', 'PUT', { safe_mode: true })
    expect(safe).toMatchObject({ safe_mode: true })
    const required = safe.mods.filter((mod) => mod.required)
    expect(required.every((mod) => mod.enabled && !mod.held_by_safe_mode)).toBe(true)
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.safe_mode_changed')).toMatchObject({ summary: 'Turned mod safe mode on' })
    await data('/mods', 'PUT', { safe_mode: false })
  })

  it('keeps required mods on for the user and the EA, while their settings still change', async () => {
    const list = await data<ModList>('/mods')
    const required = list.mods.filter((mod) => mod.required)
    expect(required.map((mod) => mod.id).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'github-webhooks',
      'poller-templates',
      'previews',
      'whats-new',
    ])
    expect(required.every((mod) => mod.enabled && mod.tier === 'bundled')).toBe(true)
    for (const auth of [USER_AUTH, EA_AUTH]) {
      const refused = await request('/mods/previews', 'PATCH', { enabled: false, settings: { pdf: false } }, auth)
      expect(refused.status).toBe(409)
      expect(await refused.text()).toContain('The Previews mod is part of Seti and always on')
    }
    expect((await data<ModDetail>('/mods/previews')).off_switches).toEqual([])
    expect((await data<ModDetail>('/mods/previews', 'PATCH', { enabled: true })).enabled).toBe(true)
    const saved = await data<ModDetail>('/mods/previews', 'PATCH', { settings: { pdf: false } }, EA_AUTH)
    expect(saved.off_switches).toEqual(['pdf'])
    await data('/mods/previews', 'PATCH', { settings: { pdf: true } })
    const uninstall = await request('/mod-admin/mods/previews/uninstall', 'POST', { delete_data: false })
    expect(uninstall.status).toBe(409)
  })

  it("filters the audit log by mods and by a mod's own kind", async () => {
    const page = await data<{ events: { actor: string }[] }>('/audit?actor=mod')
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.every((event) => event.actor.startsWith('mod:'))).toBe(true)
    const counted = await data<{ events: { kind: string }[] }>('/audit?kind=mod.sample.counted')
    expect(counted.events.map((event) => event.kind)).toEqual(['mod.sample.counted'])
    expect((await request('/audit?kind=mod.Bad')).status).toBe(400)
  })
})
