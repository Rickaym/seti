import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { Share, ShareLink } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { SETI_HOME, type PublicAccess } from './config.js'
import { tasks } from './db.js'
import { LIVE_PAGE_POLICY, LIVE_PERMISSIONS, LIVE_SHARE_CDNS } from './share-live.js'
import { parseSharePath } from './share-path.js'
import { setShareLive } from './shares.js'
import { auditEvents } from './store/audit.js'
import { EA_AUTH, USER_AUTH } from './test-auth.js'

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (_params: { prompt: unknown; options?: Options }) => {
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

const ACCESS: PublicAccess = {
  hostname: 'seti.example.com',
  origin: 'https://seti.example.com',
  cloudflare: { team: 'myteam.cloudflareaccess.com', aud: 'a'.repeat(64), allowed: null },
}
const PAGE = '<!doctype html><html><body><p id="out">static</p><script>out.textContent = "ran"</script></body></html>\n'
const TASK = 'live-share-task'
const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'share-live-'))
const app = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
const LOOPBACK = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006' }
const USER = { ...LOOPBACK, ...USER_AUTH }
const EA = { ...LOOPBACK, ...EA_AUTH }

const api = async (headers: Record<string, string>, method: string, url: string, body?: unknown) =>
  app.request(`/api${url}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function data<T>(res: Response): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const detailOf = async (res: Response) => ((await res.json()) as { error: { detail: string } }).error.detail

const publicGet = async (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  app.request(url, { method, headers: { host: ACCESS.hostname, 'cf-connecting-ip': '198.51.100.9', ...headers } })

const FRAME = { 'sec-fetch-dest': 'iframe' }

/** Links made by earlier tests, by file, for later ones that look at the same share. */
const liveLinks = new Map<string, ShareLink>()

function linkOf(file: string): ShareLink {
  const link = liveLinks.get(file)
  if (link === undefined) {
    throw new Error(`no share of ${file}`)
  }
  return link
}

const tokenOf = (link: ShareLink) => link.url.slice(link.url.lastIndexOf('/') + 1)

async function share(file: string, extra: Record<string, unknown> = {}): Promise<ShareLink> {
  return data<ShareLink>(await api(USER, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: file, ...extra }))
}

const setLive = async (id: string, live: boolean) => api(USER, 'PUT', `/shares/${id}/live`, { live })

/** Every header but the date, which moves between two requests. */
const headersOf = (res: Response) => [...res.headers.entries()].filter(([name]) => name !== 'date')

beforeAll(async () => {
  const cwd = path.join(scratch, 'agent')
  fs.mkdirSync(cwd, { recursive: true })
  for (const name of ['page.html', 'other.htm', 'still.html', 'fresh.html']) {
    fs.writeFileSync(path.join(cwd, name), PAGE)
  }
  fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello\n')
  await tasks.insert({ id: TASK, title: 'Live publisher', repo_id: null, cwd, worktree: false, pr_urls: [] })
  await data(await api(USER, 'PUT', '/shares/settings', { enabled: true }))
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the live share path', () => {
  it('names the frame and the static page, anchored like every share path', () => {
    const token = 'A'.repeat(43)
    expect(parseSharePath(`/share/${token}/live`)).toEqual({ token, part: 'live', image: 0 })
    expect(parseSharePath(`/share/${token}/static`)).toEqual({ token, part: 'static', image: 0 })
    for (const bent of ['/live/', '/live/x', '/Live', '/static.html', '/livex']) {
      expect(parseSharePath(`/share/${token}${bent}`), bent).toBeNull()
    }
  })
})

describe('a static share', () => {
  it('serves the same bytes and headers before, during and after its link is live', async () => {
    const link = await share('still.html')
    liveLinks.set('still.html', link)
    const token = tokenOf(link)
    const before = await publicGet(`/share/${token}`)
    const beforeBody = await before.text()
    expect(beforeBody).not.toContain('<script')
    expect(beforeBody).not.toContain('<iframe')
    await data(await setLive(link.share.id, true))
    const during = await publicGet(`/share/${token}/static`)
    expect(await during.text()).toBe(beforeBody)
    await data(await setLive(link.share.id, false))
    const after = await publicGet(`/share/${token}`)
    expect(await after.text()).toBe(beforeBody)
    expect(headersOf(after)).toEqual(headersOf(before))
    for (const part of ['live', 'static']) {
      expect((await publicGet(`/share/${token}/${part}`, FRAME)).status, part).toBe(404)
    }
  })
})

describe('a live share', () => {
  it('opens as a script-free shell whose frame runs the page in an opaque origin', async () => {
    const link = await share('page.html', { live: true })
    expect(link.share.live).toBe(true)
    const token = tokenOf(link)
    const shell = await publicGet(`/share/${token}`)
    expect(shell.status).toBe(200)
    const body = await shell.text()
    expect(body).not.toContain('<script')
    expect(body).toContain(
      `<iframe class="live" src="/share/${token}/live" sandbox="allow-scripts" referrerpolicy="no-referrer"`,
    )
    expect(body).toContain(`<a class="dl" href="/share/${token}/static">Static view</a>`)
    expect(shell.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; frame-src ${ACCESS.origin}/share/${token}/live; ` +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    expect(shell.headers.get('x-frame-options')).toBe('DENY')
    expect(shell.headers.get('permissions-policy')).toBe(LIVE_PERMISSIONS)
    expect(shell.headers.get('x-dns-prefetch-control')).toBe('off')

    const frame = await publicGet(`/share/${token}/live`, FRAME)
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(frame.headers.get('content-security-policy')).toBe(LIVE_PAGE_POLICY)
    expect(frame.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(frame.headers.get('permissions-policy')).toBe(LIVE_PERMISSIONS)
    for (const [name, value] of Object.entries({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    })) {
      expect(frame.headers.get(name), name).toBe(value)
    }
    expect(frame.headers.get('set-cookie')).toBeNull()
    const page = await frame.text()
    expect(page.startsWith('<!doctype html><script>')).toBe(true)
    expect(page.endsWith(PAGE.slice('<!doctype html>'.length))).toBe(true)
  })

  it('gives its frame only to a frame, never to a tab or a plain fetch', async () => {
    const link = await share('other.htm', { live: true })
    liveLinks.set('other.htm', link)
    const token = tokenOf(link)
    for (const dest of [undefined, 'document', 'empty', 'script', 'frame']) {
      const res = await publicGet(`/share/${token}/live`, dest === undefined ? {} : { 'sec-fetch-dest': dest })
      expect(res.status, dest).toBe(404)
      expect(await res.text()).toBe('Not found\n')
      expect(res.headers.get('x-frame-options'), dest).toBe('DENY')
    }
    expect((await publicGet(`/share/${token}/live`, FRAME, 'HEAD')).status).toBe(200)
  })

  it('counts the shell and the static page as views, not the frame', async () => {
    const viewsOf = async () =>
      (await data<{ shares: Share[] }>(await api(USER, 'GET', '/shares'))).shares.find(
        (each) => each.path === 'other.htm',
      )?.view_count ?? -1
    const before = await viewsOf()
    const token = tokenOf(linkOf('other.htm'))
    expect((await publicGet(`/share/${token}`)).status).toBe(200)
    expect((await publicGet(`/share/${token}/live`, FRAME)).status).toBe(200)
    expect((await publicGet(`/share/${token}/static`)).status).toBe(200)
    expect(await viewsOf()).toBe(before + 2)
  })

  it('takes its shell, frame and static page from the one per-address request budget', async () => {
    const token = tokenOf(linkOf('other.htm'))
    const from = { 'cf-connecting-ip': '198.51.100.77' }
    for (let i = 0; i < 40; i++) {
      for (const part of ['', '/live', '/static']) {
        expect((await publicGet(`/share/${token}${part}`, { ...FRAME, ...from })).status, part).toBe(200)
      }
    }
    for (const part of ['', '/live', '/static']) {
      expect((await publicGet(`/share/${token}${part}`, { ...FRAME, ...from })).status, part).toBe(429)
    }
  })

  it('allows its CDNs only by path prefix and keeps images and the network closed', () => {
    for (const cdn of LIVE_SHARE_CDNS) {
      expect(cdn.source.endsWith('/'), cdn.source).toBe(true)
      expect(cdn.reason.length).toBeGreaterThan(20)
    }
    expect(LIVE_PAGE_POLICY).toContain("connect-src 'none'")
    expect(LIVE_PAGE_POLICY).toContain('img-src data: blob:;')
    expect(LIVE_PAGE_POLICY).not.toContain('allow-same-origin')
  })
})

describe('who makes a link live', () => {
  it('refuses a file that is not HTML, on creation and later', async () => {
    const refused = await api(USER, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: 'plain.txt', live: true })
    expect(refused.status).toBe(400)
    expect(await detailOf(refused)).toBe('plain.txt is not an HTML file; only HTML files can be shared live')
    const link = await share('plain.txt')
    expect((await setLive(link.share.id, true)).status).toBe(400)
    expect((await publicGet(`/share/${tokenOf(link)}/live`, FRAME)).status).toBe(404)
  })

  it('refuses mods, through the API and the service alike', async () => {
    const mod = { id: 'sample', grants: [] }
    const viaApi = await asMod(mod, async () => api(LOOPBACK, 'PUT', '/shares/x/live', { live: true }))
    expect(viaApi.status).toBe(403)
    const create = { root: 'cwd', path: 'page.html', live: true }
    expect((await asMod(mod, async () => api(LOOPBACK, 'POST', `/tasks/${TASK}/shares`, create))).status).toBe(403)
    await expect(asMod(mod, async () => setShareLive('x', true))).rejects.toThrow(
      'Mods cannot share files outside Seti',
    )
  })

  it('refuses the EA and agents, through the API and the service alike', async () => {
    const what = 'The EA cannot share files outside Seti; the user does that in Seti'
    const create = { root: 'cwd', path: 'page.html', live: true }
    expect(await detailOf(await api(EA, 'POST', `/tasks/${TASK}/shares`, create))).toBe(what)
    expect(await detailOf(await api(EA, 'PUT', '/shares/x/live', { live: true }))).toBe(what)
    const agent = { id: TASK, title: 'Live publisher', seti_control: 'full' as const }
    const viaApi = await asAgent(agent, async () => api(LOOPBACK, 'PUT', '/shares/x/live', { live: true }))
    expect(viaApi.status).toBe(403)
    await expect(asAgent(agent, async () => setShareLive('x', true))).rejects.toThrow(
      'Agents cannot share files outside Seti',
    )
  })

  it('audits a live share as such, and each change of Live', async () => {
    await share('fresh.html', { live: true })
    const created = await auditEvents.latest('task.file_shared')
    expect(created?.summary).toContain('as a live page')
    expect(created?.detail).toMatchObject({ live: true })
    const id = linkOf('still.html').share.id
    await data(await setLive(id, true))
    expect(await auditEvents.latest('task.share_live')).toMatchObject({
      subject_id: TASK,
      summary: 'Turned on the live page of still.html of task "Live publisher"',
      detail: { live: true, path: 'still.html' },
    })
  })
})
