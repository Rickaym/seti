import type { ModFrameInfo } from '@seti/shared'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asAgent, asMod } from '../access.js'
import { createApp } from '../app.js'
import { HttpError } from '../http.js'
import { modHost } from '../mods/bundled.js'
import { framePolicy, inlineScriptHashes } from '../mods/frames/policy.js'
import { modFramePages } from '../mods/frames/source.js'
import { auditEvents } from '../store/audit.js'
import { modLogs } from '../store/mod-logic.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { modFrameRoutes } from './mod-frames.js'

const app = createApp()
const HEADERS = { host: 'localhost', ...USER_AUTH }
const FRAME = { ...HEADERS, 'sec-fetch-dest': 'iframe' }

const get = async (route: string, headers: Record<string, string> = FRAME) => app.request(`/api${route}`, { headers })

const post = async (route: string, body: unknown, auth: Record<string, string> = USER_AUTH) =>
  app.request(`/api${route}`, {
    method: 'POST',
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const detail = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

async function hash(): Promise<string> {
  const res = await get('/mod-frames/view-test', HEADERS)
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: ModFrameInfo }).data.hash
}

const call = async (body: object) => {
  const res = await post('/mod-frames/view-test/call', { view: 'board', ...body })
  return { status: res.status, body: (await res.json()) as { data?: unknown; error?: { detail: string } } }
}

beforeAll(async () => {
  await modHost.setEnabled('view-test', true)
})

afterAll(async () => {
  await modHost.setEnabled('view-test', false)
  modHost.stopAll()
})

describe('mod frames', () => {
  it('serves a running third-party view in a frame, pinned to its scripts and its package', async () => {
    const v = await hash()
    expect(v).toMatch(/^[a-f0-9]{12}$/)
    const res = await get(`/mod-frames/view-test/views/board?v=${v}`)
    expect(res.status).toBe(200)
    const html = await res.text()
    const page = modFramePages.get('view-test')?.page('views/board.html')
    expect(res.headers.get('content-security-policy')).toBe(framePolicy(page?.scriptHashes ?? []))
    expect(inlineScriptHashes(html)).toHaveLength(2)
    expect(html.startsWith('<!doctype html><script>(function () {')).toBe(true)
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const viewer = await get(`/mod-frames/view-test/viewers/viewer?v=${v}`)
    expect(viewer.status).toBe(200)
  })

  it('answers 404 for a stale package, an undeclared page, a bundled mod, and a mod that is off', async () => {
    const v = await hash()
    expect((await get('/mod-frames/view-test/views/board?v=000000000000')).status).toBe(404)
    expect((await get(`/mod-frames/view-test/views/missing?v=${v}`)).status).toBe(404)
    expect((await get(`/mod-frames/view-test/viewers/board?v=${v}`)).status).toBe(404)
    expect((await get('/mod-frames/sample', HEADERS)).status).toBe(404)
    await modHost.setEnabled('view-test', false)
    expect((await get(`/mod-frames/view-test/views/board?v=${v}`)).status).toBe(404)
    await modHost.setEnabled('view-test', true)
  })

  it('answers 404 while safe mode holds third-party mods off', async () => {
    const v = await hash()
    await modHost.setSafeMode(true)
    try {
      expect((await get(`/mod-frames/view-test/views/board?v=${v}`)).status).toBe(404)
    } finally {
      await modHost.setSafeMode(false)
    }
    expect((await get(`/mod-frames/view-test/views/board?v=${v}`)).status).toBe(200)
  })

  it('opens a page only in a frame', async () => {
    const v = await hash()
    for (const headers of [HEADERS, { ...HEADERS, 'sec-fetch-dest': 'document' }]) {
      const res = await get(`/mod-frames/view-test/views/board?v=${v}`, headers)
      expect(res.status).toBe(403)
      expect(await detail(res)).toBe("A mod's views open only inside Seti")
    }
  })

  it('refuses the EA, agents and mods, who never hold a view open', async () => {
    const v = await hash()
    const ea = await get(`/mod-frames/view-test/views/board?v=${v}`, { ...FRAME, ...EA_AUTH })
    expect(ea.status).toBe(403)
    expect((await post('/mod-frames/view-test/call', { view: 'board', op: 'settings.get' }, EA_AUTH)).status).toBe(403)
    const agent = { id: 'agent-1', title: 'Builder', seti_control: 'full' as const }
    const routes = new Hono()
      .route('/', modFrameRoutes)
      .onError((e, c) => c.text(e.message, e instanceof HttpError ? e.status : 500))
    const asAgentRes = await asAgent(agent, async () => routes.request('/view-test'))
    expect([asAgentRes.status, await asAgentRes.text()]).toEqual([403, "Only the user's own page opens a mod's views"])
    const asModRes = await asMod({ id: 'view-test', grants: ['storage'] }, async () => routes.request('/view-test'))
    expect(asModRes.status).toBe(403)
  })

  it('runs view calls as the mod under its own grants, and nothing outside the view ops', async () => {
    expect((await call({ op: 'settings.get' })).body.data).toEqual({ ok: true, value: { greeting: 'Hello' } })
    const write = (await call({ op: 'storage.set', key: 'note', value: { text: 'kept' } })).body.data
    expect(write).toMatchObject({ ok: false, error: { code: 'denied' } })
    await auditEvents.settled()
    expect(await auditEvents.latest('mod.call_refused')).toMatchObject({ subject_id: 'view-test' })
    expect((await call({ op: 'net.fetch', url: 'https://example.test' })).status).toBe(400)
    expect((await call({ op: 'tasks.list' })).status).toBe(400)
    expect((await call({ op: 'storage.get', key: 'note', modId: 'sample' })).status).toBe(400)
    expect((await call({ view: 'nowhere', op: 'settings.get' })).status).toBe(404)
    expect((await call({ op: 'command', command: 'missing' })).status).toBe(404)
    expect((await call({ op: 'storage.set', key: 'big', value: 'x'.repeat(70_000) })).status).toBe(400)
  })

  it("writes what the page reports into the mod's own log", async () => {
    const res = await post('/mod-frames/view-test/report', { view: 'board', reason: 'flooded' })
    expect(res.status).toBe(200)
    expect((await modLogs.newest('view-test', 1))[0]).toMatchObject({
      kind: 'system',
      level: 'warn',
      line: 'Its Board view sent too many messages, so Seti stopped it',
    })
    expect((await post('/mod-frames/view-test/report', { view: 'board', reason: 'bored' })).status).toBe(400)
  })
})

describe('the framed API guard', () => {
  it('gives a framed page no JSON from the API, leaving HTML previews and mod pages framed', async () => {
    const tasks = await get('/tasks')
    expect(tasks.status).toBe(403)
    expect(await detail(tasks)).toBe('Seti does not load its API into frames')
    expect((await get('/tasks', { ...HEADERS, 'sec-fetch-dest': 'empty' })).status).toBe(200)
    expect((await get('/tasks/none/files/raw?root=cwd&path=a.html')).status).not.toBe(403)
  })
})
