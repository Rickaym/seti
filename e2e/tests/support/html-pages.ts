import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { APIRequestContext, FrameLocator, Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'
import { filesPanel } from './viewer-files.js'

/** A page whose inline script writes into it, so its text shows the script ran. */
const STATUS_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Status</title></head>
<body><h1>Deploy status</h1><p id="out">Waiting for the script</p>
<script>document.getElementById('out').textContent = 'Rendered by the page script'</script>
</body></html>
`

/** A page that reaches for Seti's cookies, storage, parent and API, and lists how each went. */
const PROBE_PAGE = `<!doctype html>
<html><body><ul id="results"></ul><script>
const list = document.getElementById('results')
const report = (name, outcome) => {
  const item = document.createElement('li')
  item.textContent = name + ': ' + outcome
  list.append(item)
}
const attempt = (name, read) => {
  try {
    const value = read()
    report(name, value ? 'read ' + value : 'empty')
  } catch {
    report(name, 'blocked')
  }
}
report('origin', self.origin)
attempt('cookie', () => document.cookie)
attempt('storage', () => localStorage.getItem('seti-probe'))
attempt('parent', () => parent.document.title)
fetch('/api/tasks?probe=frame').then((res) => report('fetch', 'status ' + res.status), () => report('fetch', 'blocked'))
</script></body></html>
`

/** A page whose first script reads and writes storage at top level, as saved settings do. */
const STORAGE_PAGE = `<!doctype html>
<html><head><script>
const saved = JSON.parse(localStorage.getItem('fm-graph-settings') || '{}')
const visits = Number(sessionStorage.getItem('visits') || '0') + 1
localStorage.setItem('fm-graph-settings', JSON.stringify({ zoom: 2 }))
sessionStorage.setItem('visits', visits)
</script></head><body><p id="out">Waiting</p><script>
document.getElementById('out').textContent = [
  'saved ' + JSON.stringify(saved),
  'visits ' + visits,
  'now ' + localStorage.getItem('fm-graph-settings'),
  'keys ' + localStorage.length + ' ' + localStorage.key(0),
  document.compatMode,
].join(', ')
</script></body></html>
`

/** What the storage page writes on a fresh load: nothing saved before, standards mode kept. */
export const FRESH_STORAGE = 'saved {}, visits 1, now {"zoom":2}, keys 1 fm-graph-settings, CSS1Compat'

/** A page that loads a script, a style, an image and a beacon from the web and from a local host. */
const remotePage = (local: string) => `<!doctype html>
<html><head>
<link rel="stylesheet" href="https://example.com/remote.css">
<link rel="stylesheet" href="${local}/remote.css">
<script src="https://example.com/x.js"></script>
<script src="${local}/x.js"></script>
</head><body>
<img src="https://example.com/pixel.png" alt="Remote pixel">
<img src="${local}/pixel.png" alt="Local pixel">
<p id="state">Waiting</p>
<a id="away" href="${local}/away">Away</a>
<script>
new Image().src = 'https://example.com/beacon?d=' + encodeURIComponent(document.title)
try { navigator.sendBeacon('${local}/beacon', 'data') } catch {}
const popup = window.open('${local}/popup')
document.getElementById('state').textContent = popup === null ? 'No popup' : 'Popup opened'
</script></body></html>
`

/** A plain http server standing in for the web, counting every request that reaches it. */
export async function startFakeWeb(): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    res.end('window.leaked = true')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const close = async () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  return { url: `http://127.0.0.1:${String(port)}`, hits, close }
}

/** An idle agent whose docs hold status, probe, storage and web-reaching pages. */
export async function seedHtmlAgent(local: string): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const dir = path.join(paths.root, `html-${id.slice(0, 8)}`)
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'docs', 'status.html'), STATUS_PAGE)
  fs.writeFileSync(path.join(dir, 'docs', 'probe.html'), PROBE_PAGE)
  fs.writeFileSync(path.join(dir, 'docs', 'storage.html'), STORAGE_PAGE)
  fs.writeFileSync(path.join(dir, 'docs', 'remote.html'), remotePage(local))
  const db = openSeedDb()
  await db.idleTask(id, 'Html pages', dir, new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id, dir }
}

/** The violations a sandboxed page provokes when it reaches out, which the specs expect. */
export const PAGE_VIOLATIONS = [/^(script-src-elem|style-src-elem|img-src|connect-src|frame-src) /]

/** Console errors of those refusals and the popup, as one pattern: test.use reads two as a tuple. */
export const PAGE_CONSOLE_ERRORS = [
  /violates the following Content Security Policy directive|^Fetch API cannot load .* Refused to connect|^Blocked opening .* sandboxed frame/,
]

export const previewFrame = (page: Page, name: string): FrameLocator =>
  filesPanel(page).frameLocator(`iframe[title="Preview of ${name}"]`)

/** How each request for a host other than Seti's ended, from any frame: its failure or its answer. */
export function outsideRequests(page: Page, base: string): Map<string, string> {
  const outcomes = new Map<string, string>()
  const outside = (url: string) => new URL(url).origin !== new URL(base).origin
  const context = page.context()
  context.on('request', (request) => {
    if (outside(request.url())) {
      outcomes.set(request.url(), 'pending')
    }
  })
  context.on('requestfailed', (request) => {
    if (outside(request.url())) {
      outcomes.set(request.url(), request.failure()?.errorText ?? 'failed')
    }
  })
  context.on('response', (response) => {
    if (outside(response.url())) {
      outcomes.set(response.url(), `answered ${String(response.status())}`)
    }
  })
  return outcomes
}

/** Every request the page reached for was stopped by its policy before it left the browser. */
export async function expectAllBlocked(outcomes: Map<string, string>, local: string): Promise<void> {
  const remote = ['https://example.com/x.js', 'https://example.com/pixel.png', `${local}/x.js`, `${local}/pixel.png`]
  await expect.poll(() => remote.every((url) => outcomes.has(url))).toBe(true)
  await expect.poll(() => [...new Set(outcomes.values())]).toEqual(['csp'])
}

export const SCRIPTS_OFF_NOTE = 'This page has scripts, which are off. Turn on Scripts to run them.'

/** Turns on the open page's scripts with the Scripts toggle, by click or by tap. */
export async function turnOnScripts(page: Page, name: string, how: 'click' | 'tap'): Promise<void> {
  const panel = filesPanel(page)
  const frame = panel.locator(`iframe[title="Preview of ${name}"]`)
  await expect(frame).toHaveAttribute('sandbox', '')
  await panel.getByRole('button', { name: 'Scripts', exact: true })[how]()
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
}

/** The probe's report: an opaque origin, no cookie, parent or API, and only its own storage. */
export async function expectProbeBlocked(frame: FrameLocator): Promise<void> {
  await expect(frame.locator('#results li')).toHaveText([
    'origin: null',
    'cookie: blocked',
    'storage: empty',
    'parent: blocked',
    'fetch: blocked',
  ])
}

export const HTML_MOD_OFF_NOTE = 'HTML preview shows these files. It is off.'

/** The status a frame gets asking for the agent's docs file as a sandboxed page. */
export async function previewStatus(request: APIRequestContext, id: string, name: string): Promise<number> {
  const query = new URLSearchParams({ root: 'cwd', path: `docs/${name}`, preview: '1' })
  const res = await request.get(`/api/tasks/${id}/files/raw?${query.toString()}`, {
    headers: { 'sec-fetch-dest': 'iframe' },
  })
  return res.status()
}
