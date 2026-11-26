import { randomUUID } from 'node:crypto'
import type { APIRequestContext, BrowserContext, Page, Route } from '@playwright/test'
import { openSeedDb } from './db.js'
import { paths } from './env.js'
import { expect } from './fixtures.js'

interface Precache {
  version: string
  urls: string[]
  lazy: string[]
}

/** The id of the build a test opens Seti on; deploying brings in the server's own build. */
export const OLD_BUILD = 'e2e-build-old'

/** A file only the old build has. */
const OLD_FILE = '/assets/e2e-old-A0b1c2d3.js'

/** A file the new build's page loads; it marks the page that runs the new build. */
const NEW_FILE = '/assets/e2e-new-B0b1c2d3.js'

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

type Handler = (route: Route) => Promise<void>
type Served = [match: (url: URL) => boolean, handler: Handler][]

const NO_CACHE = { 'cache-control': 'no-cache' }

const isPage = (url: URL) => url.pathname === '/' || url.pathname === '/index.html'
const isWorker = (url: URL) => url.pathname === '/sw.js'

const servePage =
  (body: string): Handler =>
  async (route) =>
    route.fulfill({ body, contentType: 'text/html; charset=utf-8', headers: NO_CACHE })

const serveScript =
  (body: string): Handler =>
  async (route) =>
    route.fulfill({ body, contentType: 'text/javascript', headers: NO_CACHE })

const marker = (name: string) => serveScript(`document.documentElement.dataset.e2eBuild = "${name}"`)

const loading = (html: string, file: string) =>
  html.replace('</head>', `<script type="module" src="${file}"></script></head>`)

/** Answers /api/system from the server with `build` in place of the server's build. */
const reporting =
  (build: string): Handler =>
  async (route) => {
    const headers = Object.entries(route.request().headers()).filter(([name]) => name !== 'if-none-match')
    const response = await route.fetch({ headers: Object.fromEntries(headers) })
    const body = (await response.json()) as { data: Record<string, unknown> }
    await route.fulfill({ json: { ...body, data: { ...body.data, build } } })
  }

async function serve(context: BrowserContext, served: Served): Promise<void> {
  for (const [match, handler] of served) {
    await context.route(match, handler)
  }
}

interface DeployOptions {
  /** How many requests for sw.js answer 503 first, as while Seti restarts. */
  workerOutages?: number
}

export interface Deploy {
  /** The server's own build, which the deploy brings in. */
  build: string
  /** Replaces the old build with the server's own; resolves with each answer to sw.js after it. */
  run: (options?: DeployOptions) => Promise<{ workerAnswers: number[] }>
}

/**
 * Serves an old build in place of the server's own until `run`. The new build is the real one, so
 * the browser's own update checks of sw.js, which pass by the routes, fetch the new build too.
 */
export async function serveOldBuild(context: BrowserContext, request: APIRequestContext): Promise<Deploy> {
  const html = await (await request.get('/')).text()
  const build = BUILD_TAG.exec(html)?.[1] ?? ''
  expect(build, 'build id in index.html').not.toBe('')
  const worker = await (await request.get('/sw.js')).text()
  const literal = MANIFEST_LITERAL.exec(worker)?.[1] ?? ''
  expect(literal, 'precache manifest in sw.js').not.toBe('')
  const current = JSON.parse(JSON.parse(literal) as string) as Precache
  const old: Precache = { version: OLD_BUILD, urls: [...current.urls, OLD_FILE], lazy: current.lazy }
  const before: Served = [
    [isPage, servePage(loading(html.replace(`content="${build}"`, `content="${OLD_BUILD}"`), OLD_FILE))],
    [isWorker, serveScript(worker.replace(literal, JSON.stringify(JSON.stringify(old))))],
    [(url) => url.pathname === OLD_FILE, marker('old')],
    [(url) => url.pathname === '/api/system', reporting(OLD_BUILD)],
  ]
  await serve(context, before)

  const run = async ({ workerOutages = 0 }: DeployOptions = {}) => {
    for (const [match, handler] of before) {
      await context.unroute(match, handler)
    }
    const workerAnswers: number[] = []
    let outages = workerOutages
    await serve(context, [
      [isPage, servePage(loading(html, NEW_FILE))],
      [(url) => url.pathname === NEW_FILE, marker('new')],
      [
        isWorker,
        async (route) => {
          if (outages > 0) {
            outages -= 1
            workerAnswers.push(503)
            await route.fulfill({ status: 503, body: 'Seti is restarting', headers: NO_CACHE })
            return
          }
          const response = await route.fetch()
          workerAnswers.push(response.status())
          await route.fulfill({ response })
        },
      ],
    ])
    return { workerAnswers }
  }
  return { build, run }
}

/** The build of the worker that controls the page, as it answers. */
const controllerBuild = async (page: Page) =>
  page.evaluate(
    async () =>
      new Promise<string | null>((resolve) => {
        const controller = navigator.serviceWorker.controller
        if (controller === null) {
          resolve(null)
          return
        }
        const channel = new MessageChannel()
        channel.port1.onmessage = (event: MessageEvent) => {
          resolve(String(event.data))
        }
        controller.postMessage('build', [channel.port2])
      }),
  )

/** Expects the page to run the deployed build, its own file included. */
export async function expectPageOnNewBuild(page: Page, deploy: Deploy): Promise<void> {
  await expect(pageBuild(page)).toHaveAttribute('content', deploy.build, { timeout: 45_000 })
  await expect(page.locator('html')).toHaveAttribute('data-e2e-build', 'new')
}

/** Expects the page to run the deployed build under that build's worker. */
export async function expectOnNewBuild(page: Page, deploy: Deploy): Promise<void> {
  await expectPageOnNewBuild(page, deploy)
  await expect.poll(async () => controllerBuild(page)).toBe(deploy.build)
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
