import fs from 'node:fs'
import net, { type AddressInfo } from 'node:net'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import { serve } from '@hono/node-server'
import type { ShareLink, ShareList } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { SETI_HOME, UI_DIST, type PublicAccess } from './config.js'
import { sql, tasks } from './db.js'
import { parseSharePath } from './share-path.js'
import { auditEvents } from './store/audit.js'
import { USER_AUTH } from './test-auth.js'

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UI_DIST: path.join(process.env.SETI_HOME ?? '', 'ui-dist'),
}))

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
const SHELL = '<!doctype html><title>Seti shell</title>'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
)
const NOTE = [
  '# Release notes',
  '',
  '![chart](img/chart.png) ![remote](https://example.com/x.png) ![svg](img/logo.svg) ![again][logo]',
  '',
  '<script>alert(1)</script> <img src=x onerror=alert(1)>',
  '',
  '<style>body{display:none}</style>',
  '',
  'Inline <a href="javascript:alert(1)">tag</a> and <iframe src="https://example.com"></iframe>.',
  '',
  '[web](https://example.com) [js](javascript:alert(1)) [JS](JaVaScRiPt:alert(1)) [sibling](other.md)',
  '[data](data:text/html,hi) [quote](https://example.com/"onmouseover="alert(1)) <https://example.com/auto>',
  '![bad](javascript:alert(1)) [mail](mailto:me@example.com) [top](#release-notes)',
  '',
  '```html',
  '<script>alert(2)</script>',
  '```',
  '',
  '[logo]: img/chart.png',
  '',
].join('\n')
const PAGE = '<html><body><script>alert(document.cookie)</script></body></html>\n'
const FLOW = 'graph TD\n  A --> B'
const DRAWING =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"><rect width="60" height="30" fill="#369"/></svg>'
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>\n'

const scratch = fs.mkdtempSync(path.join(path.dirname(SETI_HOME), 'share-public-'))
const TASK = 'public-share-task'
const app = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
const LOOPBACK = { host: '127.0.0.1:3006', origin: 'http://127.0.0.1:3006', ...USER_AUTH }
const links = new Map<string, ShareLink>()

const publicGet = async (url: string, headers: Record<string, string> = {}, method = 'GET') =>
  app.request(url, { method, headers: { host: ACCESS.hostname, 'cf-connecting-ip': '198.51.100.7', ...headers } })

const tokenOf = (name: string) => {
  const link = links.get(name)
  if (link === undefined) {
    throw new Error(`no share of ${name}`)
  }
  return link.url.slice(link.url.lastIndexOf('/') + 1)
}

async function share(file: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await app.request(`/api/tasks/${TASK}/shares`, {
    method: 'POST',
    headers: { ...LOOPBACK, 'content-type': 'application/json' },
    body: JSON.stringify({ root: 'cwd', path: file, ...extra }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  links.set(file, ((await res.json()) as { data: ShareLink }).data)
}

const setSharing = async (enabled: boolean) =>
  app.request('/api/shares/settings', {
    method: 'PUT',
    headers: { ...LOOPBACK, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })

beforeAll(async () => {
  fs.mkdirSync(UI_DIST, { recursive: true })
  fs.writeFileSync(path.join(UI_DIST, 'index.html'), SHELL)
  const cwd = path.join(scratch, 'agent')
  fs.mkdirSync(path.join(cwd, 'img'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'notes.md'), NOTE)
  fs.writeFileSync(path.join(cwd, 'img', 'chart.png'), PNG)
  fs.writeFileSync(path.join(cwd, 'img', 'logo.svg'), SVG)
  fs.writeFileSync(path.join(cwd, 'page.html'), PAGE)
  fs.writeFileSync(path.join(cwd, 'logo.svg'), SVG)
  fs.writeFileSync(path.join(cwd, 'dot.png'), PNG)
  fs.writeFileSync(path.join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255]))
  fs.writeFileSync(path.join(cwd, 'plain.txt'), 'hello\n')
  fs.writeFileSync(path.join(cwd, 'big.md'), '- item <b>x</b>\n\n'.repeat(80_000))
  fs.writeFileSync(path.join(cwd, 'flow.md'), `# Flow\n\n\`\`\`mermaid\n${FLOW}\n\`\`\`\n`)
  await tasks.insert({ id: TASK, title: 'Publisher', repo_id: null, cwd, worktree: false, pr_urls: [] })
  expect((await setSharing(true)).status).toBe(200)
  for (const file of ['notes.md', 'page.html', 'logo.svg', 'dot.png', 'blob.bin', 'plain.txt', 'big.md']) {
    await share(file)
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

/** The policy of a share response; only a page may show images, and only its own. */
const policy = (images = "'none'") =>
  `sandbox allow-downloads; default-src 'none'; img-src ${images}; style-src 'unsafe-inline'; frame-ancestors 'none'; ` +
  "base-uri 'none'; form-action 'none'"

const EXPECTED_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'no-store',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
}

const imagesOf = (token: string) => `${ACCESS.origin}/share/${token}/p/`

/** Preview images and the card alone are readable cross-origin, by the page and by link bots. */
function expectShareHeaders(res: Response, images?: string, corp = 'same-origin'): void {
  expect(res.headers.get('content-security-policy')).toBe(policy(images))
  for (const [name, value] of Object.entries({ ...EXPECTED_HEADERS, 'cross-origin-resource-policy': corp })) {
    expect(res.headers.get(name), name).toBe(value)
  }
  expect(res.headers.get('set-cookie')).toBeNull()
  expect(res.headers.get('etag')).toBeNull()
}

describe('the share path', () => {
  const token = 'A'.repeat(43)

  it('matches only a 43 character token and its download, anchored on both ends', () => {
    expect(parseSharePath(`/share/${token}`)).toEqual({ token, part: 'page', image: 0 })
    expect(parseSharePath(`/share/${token}/raw`)).toEqual({ token, part: 'raw', image: 0 })
    expect(parseSharePath(`/share/${token}/card.png`)).toEqual({ token, part: 'card', image: 0 })
    expect(parseSharePath(`/share/${token}/p/1`)).toEqual({ token, part: 'image', image: 1 })
    expect(parseSharePath(`/share/${token}/p/50`)).toEqual({ token, part: 'image', image: 50 })
    for (const bad of [
      `/share/${token}/p/0`,
      `/share/${token}/p/01`,
      `/share/${token}/p/51`,
      `/share/${token}/p/99`,
      `/share/${token}/p/100`,
      `/share/${token}/p/-1`,
      `/share/${token}/p/1.5`,
      `/share/${token}/p/1e1`,
      `/share/${token}/p/x`,
      `/share/${token}/p/`,
      `/share/${token}/p`,
      `/share/${token}/p/1/`,
      `/share/${token}/p/1/raw`,
      `/share/${token}/p/1.webp`,
      `/share/${token}/p/%31`,
      `/share/${token}/p//1`,
      `/share/${token}/p/./1`,
      `/share/${token}/p/../raw`,
      `/share/${token}/P/1`,
      `/share/${token}/card.png/`,
      `/share/${token}/card.png.svg`,
      `/share/${token}/card.PNG`,
      `/share/${token}/card`,
      `/share/${token}/cardXpng`,
      `/share/${token}/raw/card.png`,
      `/share/${token}/card.png%00`,
      `/share/${token}%2fcard.png`,
      `/share/${token}/./card.png`,
      `/share/${token}/`,
      `/share/${token}/raw/`,
      `/share/${token}/raw/x`,
      `/share/${token}/a/x`,
      `/share/${token}A`,
      `/share/${token.slice(1)}`,
      `/share/${token}\n`,
      `/share/${token}%2fraw`,
      `/share/${token}/../../api`,
      `//share/${token}`,
      `/share//${token}`,
      `/x/share/${token}`,
      `/SHARE/${token}`,
      `/share/${'A'.repeat(42)}.`,
      `/share/../api/tasks`,
    ]) {
      expect(parseSharePath(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})

describe('the Access guard', () => {
  it('lets a GET or HEAD of a share through without any credential', async () => {
    const page = await publicGet(`/share/${tokenOf('plain.txt')}`)
    expect(page.status).toBe(200)
    expect((await publicGet(`/share/${tokenOf('plain.txt')}/raw`, {}, 'HEAD')).status).toBe(200)
    expect(links.get('plain.txt')?.url).toMatch(/^https:\/\/seti\.example\.com\/share\/[A-Za-z0-9_-]{43}$/)
  })

  it('keeps every other path and method behind Access, however the share path is bent', async () => {
    const token = tokenOf('plain.txt')
    for (const url of [
      '/api/tasks',
      '/share/../api/tasks',
      `/share/${token}/../../api/tasks`,
      `/share/${token}%2f..%2f..%2fapi%2ftasks`,
      `/share/%2e%2e/api/tasks`,
      `//share/${token}`,
      `/share//${token}`,
      `/share/${token}/`,
      `/share/${token}/raw/x`,
      `/share/${token}/a/1`,
      `/share/${token}x`,
      `/share/${token}%00`,
      `/share/${token}%0a`,
      `/share/${token}/p/0`,
      `/share/${token}/p/51`,
      `/share/${token}/p/1/`,
      `/share/${token}/p/1/../../../../api/tasks`,
      `/share/${token}/p/%2e%2e/%2e%2e/api/tasks`,
      `/share/${token}/card.png/x`,
      `/share/${token}/card.png%2f..%2f..%2fapi`,
      `/share/${token}/card.svg`,
      '/share',
      '/share/',
      '/',
    ]) {
      const res = await publicGet(url)
      expect(res.status, url).toBe(403)
      expect(await res.text(), url).not.toContain('Publisher')
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      for (const part of ['', '/p/1', '/card.png']) {
        expect((await publicGet(`/share/${token}${part}`, {}, method)).status, `${method} ${part}`).toBe(403)
      }
    }
  })

  it('answers other methods with the 404 once Access let the request through, and logs no token', async () => {
    const logged = vi.spyOn(process.stdout, 'write')
    const res = await publicGet(`/share/${tokenOf('plain.txt')}`, { 'cf-access-jwt-assertion': 'ok' }, 'POST')
    expect(res.status).toBe(404)
    expectShareHeaders(res, imagesOf(tokenOf('plain.txt')))
    const lines = logged.mock.calls.map(([line]) => String(line))
    logged.mockRestore()
    expect(lines).toContain('access: POST /share/[token] 404 by me@example.com\n')
    expect(lines.join('')).not.toContain(tokenOf('plain.txt'))
  })

  it('ignores a query string, which changes nothing', async () => {
    const res = await publicGet(`/share/${tokenOf('plain.txt')}?root=cwd&path=../../etc/passwd`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('hello')
  })

  it('normalizes dot segments before the guard on a real socket too', async () => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const { port } = server.address() as AddressInfo
    const raw = async (target: string) =>
      new Promise<string>((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1')
        let reply = ''
        socket.on('data', (chunk: Buffer) => {
          reply += chunk.toString('latin1')
        })
        socket.on('end', () => {
          resolve(reply)
        })
        socket.on('error', reject)
        socket.write(`GET ${target} HTTP/1.1\r\nHost: ${ACCESS.hostname}\r\nConnection: close\r\n\r\n`)
      })
    try {
      for (const target of [
        '/share/../api/tasks',
        '/share/%2e%2e/api/tasks',
        `/share/${'A'.repeat(43)}/../../api/tasks`,
      ]) {
        const reply = await raw(target)
        expect(reply.split('\r\n')[0], target).toBe('HTTP/1.1 403 Forbidden')
      }
      expect((await raw(`/share/${tokenOf('plain.txt')}`)).split('\r\n')[0]).toBe('HTTP/1.1 200 OK')
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('share responses', () => {
  it('carry the share headers and no cookie, whatever the answer', async () => {
    const token = tokenOf('notes.md')
    const loopback = `http://127.0.0.1:3006/share/${token}/p/`
    const cases: [Response, (string | undefined)?, string?][] = [
      [await publicGet(`/share/${token}`), imagesOf(token)],
      [await publicGet(`/share/${token}/raw`)],
      [await publicGet(`/share/${token}`, {}, 'HEAD'), imagesOf(token)],
      [await publicGet(`/share/${'B'.repeat(43)}`), imagesOf('B'.repeat(43))],
      [await publicGet(`/share/${token}/x`)],
      [await publicGet(`/share/${token}/p/1`), undefined, 'cross-origin'],
      [await publicGet(`/share/${token}/p/51`)],
      [await publicGet(`/share/${token}/card.png`), undefined, 'cross-origin'],
      [await publicGet(`/share/${'B'.repeat(43)}/card.png`), undefined, 'cross-origin'],
      [await app.request(`/share/${token}`, { headers: { host: '127.0.0.1:3006' } }), loopback],
      [await app.request('/share/nothing', { headers: { host: '127.0.0.1:3006' } })],
      [await app.request(`/share/${token}`, { headers: LOOPBACK }), loopback],
      [await app.request(`/share/${token}`, { headers: { host: 'evil; script-src *' } })],
    ]
    for (const [res, images, corp] of cases) {
      expectShareHeaders(res, images, corp)
    }
  })

  it('let only preview images and the card be read cross-origin', async () => {
    const token = tokenOf('notes.md')
    for (const part of ['p/1', 'card.png']) {
      const res = await publicGet(`/share/${token}/${part}`)
      expect(res.status, part).toBe(200)
      expect(res.headers.get('cross-origin-resource-policy'), part).toBe('cross-origin')
    }
    for (const url of [`/share/${token}`, `/share/${token}/raw`, `/share/${token}/p/51`, `/share/${token}/p/1/x`]) {
      expect((await publicGet(url)).headers.get('cross-origin-resource-policy'), url).toBe('same-origin')
    }
  })

  it('never serve the app shell for a path under /share', async () => {
    for (const url of ['/share/nothing', '/share/', '/share', `/share/${'C'.repeat(43)}/raw`]) {
      const res = await app.request(url, { headers: { host: '127.0.0.1:3006' } })
      expect(res.status, url).toBe(404)
      expect(await res.text()).toBe('Not found\n')
    }
  })

  it('render Markdown with its snapshotted image inline, raw HTML as text, and only safe links', async () => {
    const html = await (await publicGet(`/share/${tokenOf('notes.md')}`)).text()
    const body = html.slice(html.indexOf('<main>'))
    expect(body).not.toMatch(
      /<script|<style|<img src=x|<iframe|<object|<embed|<form|<base|onmouseover="|href="javascript|src="javascript/i,
    )
    const chart = `<img src="${tokenOf('notes.md')}/p/1"`
    expect(body).toContain(`${chart} alt="chart">`)
    expect(body).toContain(`${chart} alt="again">`)
    expect(body).not.toContain('data:')
    const image = await publicGet(`/share/${tokenOf('notes.md')}/p/1`)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG)
    expect((await publicGet(`/share/${tokenOf('notes.md')}/p/2`)).status).toBe(404)
    expect(body).not.toContain('https://example.com/x.png')
    expect(body).toContain('[remote]')
    expect(body).toContain('[svg]')
    expect(body).toContain('[bad]')
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(body).toContain('&lt;style&gt;body{display:none}&lt;/style&gt;')
    expect(body).toContain('&lt;a href=&quot;javascript')
    expect(body).toContain('&lt;script&gt;alert(2)&lt;/script&gt;')
    const link = (href: string, text: string) => `<a href="${href}" rel="noopener noreferrer nofollow">${text}</a>`
    expect(body).toContain(link('https://example.com', 'web'))
    expect(body).toContain(link('https://example.com/auto', 'https://example.com/auto'))
    expect(body).toContain(link('mailto:me@example.com', 'mail'))
    expect(body).toContain(link('#release-notes', 'top'))
    expect(body).toContain(link('https://example.com/&quot;onmouseover=&quot;alert(1)', 'quote'))
    for (const plain of ['js', 'JS', 'sibling', 'data']) {
      expect(body, plain).not.toContain(`>${plain}</a>`)
    }
    expect(html).toContain(`href="/share/${tokenOf('notes.md')}/raw"`)
  })

  it('show HTML as highlighted source, SVG as a picture with its source, and download both as text', async () => {
    for (const [file, source] of [
      ['page.html', PAGE],
      ['logo.svg', SVG],
    ] as const) {
      const page = await (await publicGet(`/share/${tokenOf(file)}`)).text()
      expect(page).not.toContain('<script')
      expect(page).not.toContain('<svg')
      expect(page).toMatch(/&lt;(<span class="tok-keyword">)?script/)
      const raw = await publicGet(`/share/${tokenOf(file)}/raw`)
      expect(raw.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(raw.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${file}`)
      expect(await raw.text()).toBe(source)
    }
  })

  it('show a fence the browser drew as PNG images with zoom under the same policy, and audit it', async () => {
    const diagrams = [{ language: 'mermaid', source: FLOW, light: DRAWING, dark: DRAWING }]
    await share('flow.md', { diagrams })
    const token = tokenOf('flow.md')
    const res = await publicGet(`/share/${token}`)
    expectShareHeaders(res, imagesOf(token))
    const html = await res.text()
    expect(html).not.toMatch(/<svg|<script|<form|\son\w+="/i)
    expect(html).toContain(`<source media="(prefers-color-scheme: dark)" srcset="${token}/p/2">`)
    expect(html).toContain('<label for="seti-d1-1">100%</label>')
    const image = await publicGet(`/share/${token}/p/1`)
    expect(image.headers.get('content-type')).toBe('image/png')
    expect(links.get('flow.md')?.share.preview).toMatchObject({ label: 'Markdown', images: 2 })
    expect((await auditEvents.latest('task.file_shared'))?.summary).toContain('Shared flow.md')

    const id = links.get('flow.md')?.share.id ?? ''
    const update = async (body: unknown) =>
      app.request(`/api/shares/${id}/update`, {
        method: 'POST',
        headers: { ...LOOPBACK, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    expect((await update({ diagrams: [{ language: 'mermaid', source: FLOW, light: 'x', dark: 'x' }] })).status).toBe(
      400,
    )
    expect((await update({})).status).toBe(200)
    const plain = await (await publicGet(`/share/${token}`)).text()
    expect(plain).toContain('<code class="language-mermaid">graph TD')
    expect(plain).not.toContain('<figure')
  })

  it('show Markdown over 1 MB as its source text', async () => {
    const html = await (await publicGet(`/share/${tokenOf('big.md')}`)).text()
    expect(html).toContain('<span class="l">- item &lt;b&gt;x&lt;/b&gt;</span>')
    expect(html).toContain('First 20,000 of 160,000 lines shown')
    expect(html).not.toContain('<article')
  })

  it('show a raster image from its image path and serve unknown bytes as a download', async () => {
    const page = await (await publicGet(`/share/${tokenOf('dot.png')}`)).text()
    expect(page).toContain(`src="${tokenOf('dot.png')}/p/1" width="1" height="1"`)
    expect((await publicGet(`/share/${tokenOf('dot.png')}/raw`)).headers.get('content-type')).toBe('image/png')
    const blob = await publicGet(`/share/${tokenOf('blob.bin')}/raw`)
    expect(blob.headers.get('content-type')).toBe('application/octet-stream')
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3, 255]))
    expect(await (await publicGet(`/share/${tokenOf('blob.bin')}`)).text()).toContain('No preview')
  })

  it('count GETs as views with country and a clipped user agent, never HEADs', async () => {
    const token = tokenOf('plain.txt')
    const id = links.get('plain.txt')?.share.id ?? ''
    const [before] = await sql<{ view_count: number }[]>`SELECT view_count FROM share WHERE id = ${id}`
    await publicGet(`/share/${token}`, { 'cf-ipcountry': 'de', 'user-agent': `Agent\u0007${'x'.repeat(200)}` })
    await publicGet(`/share/${token}`, {}, 'HEAD')
    const list = await app.request('/api/shares', { headers: LOOPBACK })
    const listed = ((await list.json()) as { data: ShareList }).data.shares.find((entry) => entry.id === id)
    expect(listed?.view_count).toBe((before?.view_count ?? 0) + 1)
    expect(listed?.recent_views[0]?.country).toBe('DE')
    expect(listed?.recent_views[0]?.user_agent).toBe(`Agent ${'x'.repeat(114)}`)
  })
})

describe('link previews', () => {
  const metaOf = (html: string, key: string) =>
    new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html)?.[1] ?? null

  const setLinkPreview = async (id: string, on: boolean) =>
    app.request(`/api/shares/${id}/link-preview`, {
      method: 'PUT',
      headers: { ...LOOPBACK, 'content-type': 'application/json' },
      body: JSON.stringify({ link_preview: on }),
    })

  it('tell chat apps the name, kind, size and card, with absolute URLs on the public host', async () => {
    const token = tokenOf('dot.png')
    const html = await (await publicGet(`/share/${token}`, { 'user-agent': 'Slackbot-LinkExpanding 1.0' })).text()
    expect(metaOf(html, 'og:title')).toBe('dot.png')
    expect(metaOf(html, 'og:site_name')).toBe('Seti')
    expect(metaOf(html, 'og:type')).toBe('website')
    expect(metaOf(html, 'og:description')).toBe('PNG image, 1 \u00d7 1, 70 bytes')
    expect(metaOf(html, 'og:url')).toBe(`${ACCESS.origin}/share/${token}`)
    expect(metaOf(html, 'og:image')).toBe(`${ACCESS.origin}/share/${token}/card.png`)
    expect(metaOf(html, 'og:image:width')).toBe('1200')
    expect(metaOf(html, 'og:image:height')).toBe('630')
    expect(metaOf(html, 'og:image:alt')).toBe('dot.png, shared from Seti')
    expect(metaOf(html, 'twitter:card')).toBe('summary_large_image')
    const card = await publicGet(`/share/${token}/card.png`)
    expect(card.status).toBe(200)
    expect(card.headers.get('content-type')).toBe('image/png')
    expect(card.headers.get('content-security-policy')).toBe(policy())
    const bytes = Buffer.from(await card.arrayBuffer())
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630])
    expect(links.get('dot.png')?.share).toMatchObject({
      link_preview: true,
      preview: { label: 'PNG image, 1 \u00d7 1', note: null, error: null, images: 1, card: true },
    })
  })

  it('escape a hostile name in the head', async () => {
    const html = await (await publicGet(`/share/${tokenOf('page.html')}`)).text()
    const head = html.slice(0, html.indexOf('<style>'))
    expect(head).not.toContain('<script')
    expect(metaOf(head, 'og:description')).toBe('HTML code, 1 line, 66 bytes')
  })

  it('name only the file when the link preview is off, and the card is gone', async () => {
    const token = tokenOf('plain.txt')
    const id = links.get('plain.txt')?.share.id ?? ''
    expect((await setLinkPreview(id, false)).status).toBe(200)
    const html = await (await publicGet(`/share/${token}`)).text()
    expect(metaOf(html, 'og:title')).toBe('plain.txt')
    expect(metaOf(html, 'og:image')).toBeNull()
    expect(metaOf(html, 'og:description')).toBeNull()
    expect(metaOf(html, 'description')).toBeNull()
    expect(metaOf(html, 'twitter:card')).toBe('summary')
    const card = await publicGet(`/share/${token}/card.png`)
    expect(card.status).toBe(404)
    expect(await card.text()).toBe('Not found\n')
    expect(await auditEvents.latest('task.share_link_preview')).toMatchObject({ subject_id: TASK })
    expect((await setLinkPreview(id, true)).status).toBe(200)
    expect((await publicGet(`/share/${token}/card.png`)).status).toBe(200)
  })

  it('count fetches by link preview bots apart from views', async () => {
    const token = tokenOf('notes.md')
    const id = links.get('notes.md')?.share.id ?? ''
    const listed = async () =>
      (
        (await (await app.request('/api/shares', { headers: LOOPBACK })).json()) as { data: ShareList }
      ).data.shares.find((entry) => entry.id === id)
    const before = await listed()
    for (const agent of [
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'WhatsApp/2.23.20.0 A',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'TelegramBot (like TwitterBot)',
      'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    ]) {
      expect((await publicGet(`/share/${token}`, { 'user-agent': agent })).status, agent).toBe(200)
    }
    await publicGet(`/share/${token}`, { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })
    const after = await listed()
    expect(after?.unfurl_count).toBe((before?.unfurl_count ?? 0) + 7)
    expect(after?.view_count).toBe((before?.view_count ?? 0) + 1)
    expect(after?.recent_unfurls.map((view) => view.unfurler)).toEqual([
      'LinkedIn',
      'Telegram',
      'Discord',
      'X',
      'Facebook',
    ])
    expect(after?.recent_views[0]?.unfurler).toBeNull()
  })

  it('let a page load its fifty images within the image budget, past the page budget', async () => {
    const limited = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
    const token = tokenOf('notes.md')
    for (let i = 0; i < 130; i++) {
      const res = await limited.request(`/share/${token}/p/1`, {
        headers: { host: ACCESS.hostname, 'cf-connecting-ip': '203.0.113.30' },
      })
      expect(res.status).toBe(200)
    }
  })
})

describe('a link that does not open', () => {
  /** A response with the token it was asked for blanked, since the page policy names its own path. */
  const sameAs = async (res: Response) => ({
    status: res.status,
    body: await res.text(),
    headers: [...res.headers.entries()]
      .filter(([name]) => name !== 'date')
      .map(([name, value]) => [name, value.replace(/\/share\/[A-Za-z0-9_-]{43}\//, '/share/TOKEN/')]),
  })

  it('reads the same for unknown, revoked, expired and switched-off shares', async () => {
    const unknown = await sameAs(await publicGet(`/share/${'D'.repeat(43)}`))
    expect(unknown.status).toBe(404)
    expect(unknown.body).toBe('Not found\n')

    let client = 0
    const fresh = async (url: string) => {
      client += 1
      return publicGet(url, { 'cf-connecting-ip': `192.0.2.${String(client)}` })
    }
    const unknownOf = async (part: string) => sameAs(await fresh(`/share/${'D'.repeat(43)}${part}`))
    const parts = ['', '/raw', '/p/1', '/card.png']
    const expectClosed = async (file: string) => {
      for (const part of parts) {
        expect(await sameAs(await fresh(`/share/${tokenOf(file)}${part}`)), `${file}${part}`).toEqual(
          await unknownOf(part),
        )
      }
    }
    expect((await publicGet(`/share/${tokenOf('dot.png')}/card.png`)).status).toBe(200)
    expect((await publicGet(`/share/${tokenOf('dot.png')}/p/1`)).status).toBe(200)

    const expired = links.get('blob.bin')?.share.id ?? ''
    await sql`UPDATE share SET expires_at = ${new Date(Date.now() - 1000).toISOString()} WHERE id = ${expired}`
    await expectClosed('blob.bin')

    const revoked = links.get('dot.png')?.share.id ?? ''
    await app.request(`/api/shares/${revoked}`, { method: 'DELETE', headers: LOOPBACK })
    await expectClosed('dot.png')
    expect(await sql`SELECT 1 FROM share_image WHERE share_id = ${revoked}`).toHaveLength(0)

    expect((await setSharing(false)).status).toBe(200)
    await expectClosed('plain.txt')
    expect((await setSharing(true)).status).toBe(200)
    expect((await publicGet(`/share/${tokenOf('plain.txt')}`)).status).toBe(200)
  })

  it('turns into 429 after 30 misses a minute from one address, for that address only', async () => {
    const limited = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
    const from = async (ip: string, url: string) =>
      limited.request(url, { headers: { host: ACCESS.hostname, 'cf-connecting-ip': ip } })
    for (let i = 0; i < 30; i++) {
      expect((await from('203.0.113.9', `/share/${'E'.repeat(43)}`)).status).toBe(404)
    }
    const blocked = await from('203.0.113.9', `/share/${'E'.repeat(43)}`)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('60')
    expectShareHeaders(blocked, imagesOf('E'.repeat(43)))
    expect((await from('203.0.113.9', `/share/${tokenOf('plain.txt')}`)).status).toBe(429)
    expect((await from('203.0.113.10', `/share/${'E'.repeat(43)}`)).status).toBe(404)
    expect((await from('203.0.113.10', `/share/${tokenOf('plain.txt')}`)).status).toBe(200)
  })

  it('turns into 429 after 120 requests a minute from one address, links that open included', async () => {
    const limited = createApp({ access: ACCESS, verify: async () => Promise.resolve('me@example.com') })
    const from = async (ip: string) =>
      limited.request(`/share/${tokenOf('plain.txt')}`, { headers: { host: ACCESS.hostname, 'cf-connecting-ip': ip } })
    for (let i = 0; i < 120; i++) {
      expect((await from('203.0.113.20')).status).toBe(200)
    }
    expect((await from('203.0.113.20')).status).toBe(429)
    expect((await from('203.0.113.21')).status).toBe(200)
  })
})
