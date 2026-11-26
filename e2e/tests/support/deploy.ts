import { randomUUID } from 'node:crypto'
import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

interface Precache {
  version: string
  urls: string[]
  lazy: string[]
}

/** The id of the build a test deploys over the one the server was built with. */
export const BUILD_B = 'e2e-build-b'

/** A file only build B has; it marks the page that runs it. */
const CHANGED = '/assets/e2e-changed-B0b1c2d3.js'

/** The build bakes the manifest into sw.js as a JSON string literal passed to JSON.parse. */
const MANIFEST_LITERAL = /JSON\.parse\(("\{\\"version(?:[^"\\]|\\.)*")\)/

const BUILD_TAG = /<meta name="seti-build" content="([\w-]+)"/

export const pageBuild = (page: Page) => page.locator('meta[name="seti-build"]')

/** Opens Seti and waits until its service worker controls the page. */
export async function openControlled(page: Page, hash = ''): Promise<string> {
  await page.goto(`/${hash}`)
  await expect(page.getByRole('contentinfo')).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .not.toBe(null)
  return (await pageBuild(page).getAttribute('content')) ?? ''
}

async function buildB(request: APIRequestContext): Promise<{ page: string; worker: string }> {
  const html = await (await request.get('/')).text()
  const served = BUILD_TAG.exec(html)?.[1] ?? ''
  expect(served, 'build id in index.html').not.toBe('')
  const page = html
    .replace(`content="${served}"`, `content="${BUILD_B}"`)
    .replace('</head>', `<script type="module" src="${CHANGED}"></script></head>`)
  const script = await (await request.get('/sw.js')).text()
  const literal = MANIFEST_LITERAL.exec(script)?.[1] ?? ''
  expect(literal, 'precache manifest in sw.js').not.toBe('')
  const current = JSON.parse(JSON.parse(literal) as string) as Precache
  const next: Precache = { version: BUILD_B, urls: [...current.urls, CHANGED], lazy: current.lazy }
  return { page, worker: script.replace(literal, JSON.stringify(JSON.stringify(next))) }
}

interface DeployOptions {
  /** How many requests for sw.js answer 503 first, as while Seti restarts. */
  workerOutages?: number
}

/** Serves build B in place of the built one: its page, worker, a changed file and its build id. */
export async function deployBuildB(
  context: BrowserContext,
  request: APIRequestContext,
  { workerOutages = 0 }: DeployOptions = {},
): Promise<void> {
  const b = await buildB(request)
  let outages = workerOutages
  const noCache = { 'cache-control': 'no-cache' }
  await context.route(
    (url) => url.pathname === '/' || url.pathname === '/index.html',
    async (route) => route.fulfill({ body: b.page, contentType: 'text/html; charset=utf-8', headers: noCache }),
  )
  await context.route(
    (url) => url.pathname === '/sw.js',
    async (route) => {
      if (outages > 0) {
        outages -= 1
        await route.fulfill({ status: 503, body: 'Seti is restarting', headers: noCache })
        return
      }
      await route.fulfill({ body: b.worker, contentType: 'text/javascript', headers: noCache })
    },
  )
  await context.route(
    (url) => url.pathname === CHANGED,
    async (route) =>
      route.fulfill({ body: 'document.documentElement.dataset.e2eBuild = "B"', contentType: 'text/javascript' }),
  )
  await context.route(
    (url) => url.pathname === '/api/system',
    async (route) => {
      const headers = Object.entries(route.request().headers()).filter(([name]) => name !== 'if-none-match')
      const response = await route.fetch({ headers: Object.fromEntries(headers) })
      const body = (await response.json()) as { data: Record<string, unknown> }
      await route.fulfill({ json: { ...body, data: { ...body.data, build: BUILD_B } } })
    },
  )
}

/** Expects the page to run build B under build B's worker, with no older cache left. */
export async function expectOnBuildB(page: Page): Promise<void> {
  await expect(pageBuild(page)).toHaveAttribute('content', BUILD_B, { timeout: 30_000 })
  await expect(page.locator('html')).toHaveAttribute('data-e2e-build', 'B')
  await expect.poll(async () => page.evaluate(async () => caches.keys())).toEqual([`seti-shell-${BUILD_B}`])
}

/** Counts the page's loads from now on. */
export function countLoads(page: Page): () => number {
  let loads = 0
  page.on('load', () => {
    loads += 1
  })
  return () => loads
}

/** An idle agent written straight into the database, so its chat has a Reply box. */
export async function seedIdleAgent(title: string): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  const at = new Date().toISOString()
  await db.idleTask(id, title, paths.checkout, at)
  await db.message(id, 'prompt', JSON.stringify({ text: `First prompt of ${title}.` }), at)
  await db.close()
  return id
}

/** Makes the page report itself hidden or visible, as when an app goes to the background and back. */
export async function setPageHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((isHidden) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (isHidden ? 'hidden' : 'visible'),
    })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => isHidden })
    document.dispatchEvent(new Event('visibilitychange'))
  }, hidden)
}
