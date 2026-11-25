import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Browser, BrowserContext, Frame, Page } from '@playwright/test'
import type { Envelope, ShareLink } from '@seti/shared'
import { openSeedDb } from './db.js'
import { LOCAL_TOKENS, paths } from './env.js'
import { expect } from './fixtures.js'

/** A server standing in for the rest of the web, counting every request that reaches it. */
export interface Elsewhere {
  url: string
  hits: string[]
  close: () => Promise<void>
}

/** Serves a page framing ?src=, to frame Seti from another site, and logs every other request. */
export async function startElsewhere(): Promise<Elsewhere> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'https://elsewhere.invalid')
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><iframe src="${url.searchParams.get('src') ?? ''}"></iframe>`)
      return
    }
    hits.push(req.url ?? '')
    res.end('window.leaked = true')
  })
  server.on('upgrade', (req, socket) => {
    hits.push(`upgrade ${req.url ?? ''}`)
    socket.destroy()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const close = async () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        resolve()
      })
    })
  return { url: `http://127.0.0.1:${String(port)}`, hits, close }
}

/** Tries what a hostile page would, reporting each as `name: outcome` into #results, then #done. */
export const PROBE = (web: string, seti: string) => `(function () {
  var list = document.getElementById('results')
  var report = function (name, outcome) {
    var item = document.createElement('li'); item.textContent = name + ': ' + outcome; list.append(item)
  }
  var attempt = function (name, act) {
    try { var value = act(); report(name, value === null || value === undefined || value === '' ? 'empty' : 'read ' + value) }
    catch (e) { report(name, 'blocked') }
  }
  var later = function (name, act) {
    return Promise.resolve().then(act).then(function (v) { report(name, 'read ' + v) }, function () { report(name, 'blocked') })
  }
  report('origin', self.origin)
  attempt('cookie', function () { return document.cookie })
  attempt('cookie write', function () { document.cookie = 'probe=1'; return 'written' })
  attempt('saved', function () { var v = localStorage.getItem('probe'); localStorage.setItem('probe', 'kept'); return v })
  attempt('indexedDB', function () { indexedDB.open('probe'); return 'opened' })
  attempt('parent', function () { return parent.document.title })
  attempt('top', function () { return top.location.href })
  attempt('opener', function () { return window.opener })
  attempt('popup', function () { return window.open('${web}/popup') })
  try { top.location.href = '${web}/top' } catch (e) {}
  try { new WebSocket('${web.replace('http', 'ws')}/socket') } catch (e) {}
  try { new EventSource('${web}/events') } catch (e) {}
  try { navigator.sendBeacon('${web}/beacon', 'data') } catch (e) {}
  try { new Image().src = '${web}/pixel' } catch (e) {}
  try { new FontFace('probe', 'url(${web}/font)').load().catch(function () {}) } catch (e) {}
  try { var x = new XMLHttpRequest(); x.open('GET', '${web}/xhr'); x.send() } catch (e) {}
  try { new Worker(URL.createObjectURL(new Blob(['fetch("${web}/worker")']))) } catch (e) {}
  Promise.all([
    later('caches', function () { return caches.keys() }),
    later('service worker', function () { return navigator.serviceWorker.register('sw.js') }),
    later('fetch Seti', function () { return fetch('${seti}/api/shares', { credentials: 'include' }).then(function (r) { return r.status }) }),
    later('fetch web', function () { return fetch('${web}/fetch').then(function (r) { return r.status }) }),
  ]).then(function () { setTimeout(function () { document.getElementById('done').textContent = 'done' }, 300) })
})()`

/** What the probe reports in an isolated frame, in any browser, on each load. */
export const PROBE_BLOCKED = [
  'origin: null',
  'cookie: blocked',
  'cookie write: blocked',
  'saved: empty',
  'indexedDB: blocked',
  'parent: blocked',
  'top: blocked',
  'opener: empty',
  'popup: empty',
]

export const PROBE_LATER = ['caches: blocked', 'service worker: blocked', 'fetch Seti: blocked', 'fetch web: blocked']

/** Markup that loads from the web without any script of its own. */
const loaders = (web: string) => `<link rel="prefetch" href="${web}/prefetch">
<link rel="preload" as="image" href="${web}/preload"><link rel="stylesheet" href="${web}/style.css">
<link rel="icon" href="${web}/icon"><link rel="manifest" href="${web}/manifest">
<style>@import url(${web}/import.css); body { background: url(${web}/background) }
@font-face { font-family: probe; src: url(${web}/face) } p { font-family: probe }</style>
<base href="${web}/base/">`

const embeds = (web: string) => `<img src="${web}/img" alt=""><img src="relative.png" alt="">
<script src="${web}/script.js"></script><iframe src="${web}/frame"></iframe>
<iframe srcdoc="<img src='${web}/srcdoc-img'><script>fetch('${web}/srcdoc-fetch').catch(function () {})</script>"></iframe>
<iframe src="javascript:'<img src=${web}/js-frame>'"></iframe>
<object data="${web}/object"></object><embed src="${web}/embed"><video src="${web}/video"></video>
<svg><image href="${web}/svg-image"/></svg>
<form id="post" action="${web}/form" method="post"><input name="a" value="b"><button id="send">Send</button></form>
<form action="${web}/form-top" target="_top"><button id="send-top">Send to top</button></form>
<a id="self" href="${web}/link">Self</a> <a id="to-top" href="${web}/link-top" target="_top">Top</a>
<a id="blank" href="${web}/link-blank" target="_blank">Blank</a> <a id="save" href="data:text/plain,hi" download="x.txt">Save</a>`

/** The probe page; `seti` is Seti's origin, which the probe asks for the owner's shares. */
const probePage = (web: string, seti: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title>${loaders(web)}</head><body><h1>Page probe</h1>
<ul id="results"></ul><p id="done"></p>${embeds(web)}
<script>${PROBE(web, seti)}</script></body></html>
`

/** Pages that try to leave their frame as soon as they load. */
const leavers = (web: string, seti: string): Record<string, string> => ({
  'away.html': `<!doctype html><p>Away</p><script>location.href = '${web}/away'</script>`,
  'refresh.html': `<!doctype html><meta http-equiv="refresh" content="0;url=${web}/refresh-now"><p>Refresh</p>`,
  'api.html': `<!doctype html><p>Api</p><script>location.href = '${seti}/api/shares'</script>`,
  'app.html': `<!doctype html><p>App</p><script>location.href = '/'</script>`,
  'data.html': `<!doctype html><p>Data</p><script>location.href = 'data:text/html,<img src=${web}/data-nav>'</script>`,
})

/** A page that loads its probe from an allowed CDN path, and tries paths and images it may not. */
const cdnPage = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="https://unpkg.com/page-probe@1.0.0/probe.css">
<script src="https://cdnjs.cloudflare.com/other/probe.js"></script>
<script src="https://cdn.jsdelivr.net/gh/someone/repo/probe.js"></script></head>
<body><h1>CDN probe</h1><ul id="results"></ul><p id="done"></p>
<img src="https://cdn.jsdelivr.net/npm/page-probe@1.0.0/pixel.png" alt="">
<script src="https://cdn.jsdelivr.net/npm/page-probe@1.0.0/probe.js"></script></body></html>
`

export const CDN_PROBE_URL = 'https://cdn.jsdelivr.net/npm/page-probe@1.0.0/probe.js'
export const CDN_STYLE_URL = 'https://unpkg.com/page-probe@1.0.0/probe.css'

/** An idle agent whose docs hold the probe, the pages that try to leave, and the CDN probe. */
export async function seedProbeAgent(web: string, seti: string): Promise<{ id: string }> {
  const id = randomUUID()
  const docs = path.join(paths.root, `pages-${id.slice(0, 8)}`, 'docs')
  fs.mkdirSync(docs, { recursive: true })
  fs.writeFileSync(path.join(docs, 'probe.html'), probePage(web, seti))
  fs.writeFileSync(path.join(docs, 'cdn.html'), cdnPage)
  for (const [name, page] of Object.entries(leavers(web, seti))) {
    fs.writeFileSync(path.join(docs, name), page)
  }
  const db = openSeedDb()
  await db.idleTask(id, 'Shared pages', path.dirname(docs), new Date(Date.now() - 60_000).toISOString())
  await db.close()
  return { id }
}

export const LEAVERS = ['away.html', 'refresh.html', 'api.html', 'app.html', 'data.html']

/** Shares one of the agent's docs as a rendered page through the API and returns its link. */
export async function shareHtml(context: BrowserContext, taskId: string, file: string): Promise<string> {
  const res = await context.request.post(`/api/tasks/${taskId}/shares`, {
    data: { root: 'cwd', path: `docs/${file}` },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return ((await res.json()) as Envelope<ShareLink>).data.url
}

/** A browser signed in to Seti the way the owner's is: by its HttpOnly session cookie alone. */
export async function ownerContext(browser: Browser, baseURL: string): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL, acceptDownloads: true })
  const res = await context.request.post('/api/local-session', {
    data: { token: LOCAL_TOKENS.user },
    headers: { origin: baseURL },
  })
  expect(res.ok(), await res.text()).toBe(true)
  return context
}

/** The owner's session still works: the cookie is there and the API answers with it. */
export async function expectOwnerSignedIn(context: BrowserContext): Promise<void> {
  expect((await context.cookies()).map((cookie) => cookie.name)).toContain('seti_local')
  expect((await context.request.get('/api/shares')).status()).toBe(200)
}

const FRAME_PATH = /\/share\/[A-Za-z0-9_-]{43}\/frame$/

/** The page frame of a shell page, once its document has loaded. */
export async function pageFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => FRAME_PATH.test(frame.url()))).toBe(true)
  const frame = page.frames().find((each) => FRAME_PATH.test(each.url()))
  if (frame === undefined) {
    throw new Error('no page frame')
  }
  await frame.waitForLoadState()
  return frame
}

/** Lets a page's late attempts leave the browser, then asserts none reached the web. */
export async function expectNothingReached(web: Elsewhere): Promise<void> {
  await delay(1000)
  expect(web.hits).toEqual([])
}

/** Every response the context got, by URL; a request a policy refused never gets one. */
export function responses(context: BrowserContext): string[] {
  const urls: string[] = []
  context.on('response', (response) => {
    urls.push(response.url())
  })
  return urls
}
