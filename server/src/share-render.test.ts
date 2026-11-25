import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { Share, ShareLink } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { asAgent, asMod } from './access.js'
import { createApp } from './app.js'
import { SETI_HOME, type PublicAccess } from './config.js'
import { now, tasks } from './db.js'
import { parseSharePath } from './share-path.js'
import { SHARE_FRAME_POLICY, RENDER_PERMISSIONS, SHARE_PAGE_CDNS } from './share-render.js'
import { setShareRender } from './shares.js'
import { auditEvents } from './store/audit.js'
import { shareRows } from './store/shares.js'
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
const TASK = 'render-share-task'
const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'share-render-'))
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
const links = new Map<string, ShareLink>()

function linkOf(file: string): ShareLink {
  const link = links.get(file)
  if (link === undefined) {
    throw new Error(`no share of ${file}`)
  }
  return link
}

const tokenOf = (link: ShareLink) => link.url.slice(link.url.lastIndexOf('/') + 1)

async function share(file: string, extra: Record<string, unknown> = {}): Promise<ShareLink> {
  const link = await data<ShareLink>(
    await api(USER, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: file, ...extra }),
  )
  links.set(file, link)
  return link
}

const setRender = async (id: string, render: boolean) => api(USER, 'PUT', `/shares/${id}/render`, { render })

/** Every header but the date, which moves between two requests. */
const headersOf = (res: Response) => [...res.headers.entries()].filter(([name]) => name !== 'date')

beforeAll(async () => {
  const cwd = path.join(scratch, 'agent')
  fs.mkdirSync(cwd, { recursive: true })
  for (const name of ['page.html', 'other.htm', 'still.html', 'fresh.html', 'code.html']) {
    fs.writeFileSync(path.join(cwd, name), PAGE)
  }
  fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello\n')
  fs.writeFileSync(path.join(cwd, 'page.md'), PAGE)
  await tasks.insert({ id: TASK, title: 'Page publisher', repo_id: null, cwd, worktree: false, pr_urls: [] })
  await data(await api(USER, 'PUT', '/shares/settings', { enabled: true }))
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('the rendered share path', () => {
  it('names the frame and the code view, anchored like every share path', () => {
    const token = 'A'.repeat(43)
    expect(parseSharePath(`/share/${token}/frame`)).toEqual({ token, part: 'frame', image: 0 })
    expect(parseSharePath(`/share/${token}/code`)).toEqual({ token, part: 'code', image: 0 })
    for (const bent of ['/frame/', '/frame/x', '/Frame', '/code.html', '/codex', '/live', '/static']) {
      expect(parseSharePath(`/share/${token}${bent}`), bent).toBeNull()
    }
  })
})

/** The page a link answers and its code view, which must match a share that does not render. */
async function expectCodeView(token: string): Promise<{ body: string; headers: [string, string][] }> {
  const res = await publicGet(`/share/${token}`)
  const body = await res.text()
  expect(body).not.toContain('<script')
  expect(body).not.toContain('<iframe')
  for (const part of ['frame', 'code']) {
    expect((await publicGet(`/share/${token}/${part}`, FRAME)).status, part).toBe(404)
  }
  return { body, headers: headersOf(res) }
}

describe('a share that does not render', () => {
  it('shows an HTML file as code when the user turns Render off, the same page as its code view', async () => {
    const link = await share('still.html', { render: false })
    expect(link.share.render).toBe(false)
    const token = tokenOf(link)
    const before = await expectCodeView(token)
    await data(await setRender(link.share.id, true))
    const during = await publicGet(`/share/${token}/code`)
    expect(await during.text()).toBe(before.body)
    expect(headersOf(during)).toEqual(before.headers)
    await data(await setRender(link.share.id, false))
    expect(await expectCodeView(token)).toEqual(before)
  })

  it('never renders a file that is not HTML, even when its row says so', async () => {
    for (const file of ['plain.txt', 'page.md']) {
      const link = await share(file)
      expect(link.share.render, file).toBe(false)
      const token = tokenOf(link)
      const before = await expectCodeView(token)
      expect(before.headers).toContainEqual([
        'content-security-policy',
        expect.stringMatching(/^sandbox allow-downloads; default-src 'none'; /),
      ])
      expect(await shareRows.setRender(link.share.id, true, now())).toBe(true)
      expect(await expectCodeView(token), file).toEqual(before)
    }
  })
})

describe('a rendered share', () => {
  it('renders an HTML file by default, as a script-free shell whose frame runs the page in an opaque origin', async () => {
    const link = await share('page.html')
    expect(link.share.render).toBe(true)
    const token = tokenOf(link)
    const shell = await publicGet(`/share/${token}`)
    expect(shell.status).toBe(200)
    const body = await shell.text()
    expect(body).not.toContain('<script')
    expect(body).toContain(
      `<iframe class="page" src="/share/${token}/frame" sandbox="allow-scripts" referrerpolicy="no-referrer"`,
    )
    expect(body).toContain(`<a class="dl" href="/share/${token}/code">View code</a>`)
    expect(body).not.toMatch(/live/i)
    expect(shell.headers.get('content-security-policy')).toBe(
      `default-src 'none'; style-src 'unsafe-inline'; frame-src ${ACCESS.origin}/share/${token}/frame; ` +
        "frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    )
    expect(shell.headers.get('x-frame-options')).toBe('DENY')
    expect(shell.headers.get('permissions-policy')).toBe(RENDER_PERMISSIONS)
    expect(shell.headers.get('x-dns-prefetch-control')).toBe('off')

    const frame = await publicGet(`/share/${token}/frame`, FRAME)
    expect(frame.status).toBe(200)
    expect(frame.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(frame.headers.get('content-security-policy')).toBe(SHARE_FRAME_POLICY)
    expect(frame.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(frame.headers.get('permissions-policy')).toBe(RENDER_PERMISSIONS)
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
    const link = await share('other.htm')
    const token = tokenOf(link)
    for (const dest of [undefined, 'document', 'empty', 'script', 'frame']) {
      const res = await publicGet(`/share/${token}/frame`, dest === undefined ? {} : { 'sec-fetch-dest': dest })
      expect(res.status, dest).toBe(404)
      expect(await res.text()).toBe('Not found\n')
      expect(res.headers.get('x-frame-options'), dest).toBe('DENY')
    }
    expect((await publicGet(`/share/${token}/frame`, FRAME, 'HEAD')).status).toBe(200)
  })

  it('counts the shell and the code view as views, not the frame', async () => {
    const viewsOf = async () =>
      (await data<{ shares: Share[] }>(await api(USER, 'GET', '/shares'))).shares.find(
        (each) => each.path === 'other.htm',
      )?.view_count ?? -1
    const before = await viewsOf()
    const token = tokenOf(linkOf('other.htm'))
    expect((await publicGet(`/share/${token}`)).status).toBe(200)
    expect((await publicGet(`/share/${token}/frame`, FRAME)).status).toBe(200)
    expect((await publicGet(`/share/${token}/code`)).status).toBe(200)
    expect(await viewsOf()).toBe(before + 2)
  })

  it('takes its shell, frame and code view from the one per-address request budget', async () => {
    const token = tokenOf(linkOf('other.htm'))
    const from = { 'cf-connecting-ip': '198.51.100.77' }
    for (let i = 0; i < 40; i++) {
      for (const part of ['', '/frame', '/code']) {
        expect((await publicGet(`/share/${token}${part}`, { ...FRAME, ...from })).status, part).toBe(200)
      }
    }
    for (const part of ['', '/frame', '/code']) {
      expect((await publicGet(`/share/${token}${part}`, { ...FRAME, ...from })).status, part).toBe(429)
    }
  })

  it('allows its CDNs only by path prefix and keeps images and the network closed', () => {
    for (const cdn of SHARE_PAGE_CDNS) {
      expect(cdn.source.endsWith('/'), cdn.source).toBe(true)
      expect(cdn.reason.length).toBeGreaterThan(20)
    }
    expect(SHARE_FRAME_POLICY).toContain("connect-src 'none'")
    expect(SHARE_FRAME_POLICY).toContain('img-src data: blob:;')
    expect(SHARE_FRAME_POLICY).not.toContain('allow-same-origin')
  })
})

describe('who sets Render', () => {
  it('refuses a file that is not HTML, on creation and later', async () => {
    const refused = await api(USER, 'POST', `/tasks/${TASK}/shares`, { root: 'cwd', path: 'plain.txt', render: true })
    expect(refused.status).toBe(400)
    expect(await detailOf(refused)).toBe('plain.txt is not an HTML file; only an HTML file renders as a page')
    const link = linkOf('plain.txt')
    expect((await setRender(link.share.id, true)).status).toBe(400)
  })

  it('refuses mods, through the API and the service alike', async () => {
    const mod = { id: 'sample', grants: [] }
    const viaApi = await asMod(mod, async () => api(LOOPBACK, 'PUT', '/shares/x/render', { render: false }))
    expect(viaApi.status).toBe(403)
    const create = { root: 'cwd', path: 'page.html' }
    expect((await asMod(mod, async () => api(LOOPBACK, 'POST', `/tasks/${TASK}/shares`, create))).status).toBe(403)
    await expect(asMod(mod, async () => setShareRender('x', true))).rejects.toThrow(
      'Mods cannot share files outside Seti',
    )
  })

  it('refuses the EA and agents, through the API and the service alike', async () => {
    const what = 'The EA cannot share files outside Seti; the user does that in Seti'
    const create = { root: 'cwd', path: 'page.html' }
    expect(await detailOf(await api(EA, 'POST', `/tasks/${TASK}/shares`, create))).toBe(what)
    expect(await detailOf(await api(EA, 'PUT', '/shares/x/render', { render: true }))).toBe(what)
    const agent = { id: TASK, title: 'Page publisher', seti_control: 'full' as const }
    const viaApi = await asAgent(agent, async () => api(LOOPBACK, 'PUT', '/shares/x/render', { render: true }))
    expect(viaApi.status).toBe(403)
    await expect(asAgent(agent, async () => setShareRender('x', true))).rejects.toThrow(
      'Agents cannot share files outside Seti',
    )
  })

  it('audits whether a new link renders, and each change of Render', async () => {
    await share('fresh.html')
    const created = await auditEvents.latest('task.file_shared')
    expect(created?.detail).toMatchObject({ render: true, path: 'fresh.html' })
    await share('code.html', { render: false })
    expect((await auditEvents.latest('task.file_shared'))?.detail).toMatchObject({ render: false })
    const id = linkOf('still.html').share.id
    await data(await setRender(id, true))
    expect(await auditEvents.latest('task.share_render')).toMatchObject({
      subject_id: TASK,
      summary: 'Turned on rendering of still.html of task "Page publisher"',
      detail: { render: true, path: 'still.html' },
    })
  })
})
