import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'
import { expect, test, toasts } from './support/fixtures.js'

test.use({ serviceWorkers: 'allow', allowedHttpStatuses: [500] })

interface Precache {
  version: string
  urls: string[]
  lazy: string[]
}

/** The build bakes the manifest into sw.js as a JSON string literal passed to JSON.parse. */
const MANIFEST_LITERAL = /JSON\.parse\(("\{\\"version(?:[^"\\]|\\.)*")\)/

const ADDED = '/assets/e2e-added-Qx81Za2b.js'

async function controlledPage(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .not.toBe(null)
}

/** Serves /sw.js?next as the built worker with a new version and one new hashed file. */
async function serveNextWorker(
  context: BrowserContext,
  request: APIRequestContext,
  version: string,
): Promise<string[]> {
  const script = await (await request.get('/sw.js')).text()
  const literal = MANIFEST_LITERAL.exec(script)?.[1]
  expect(literal, 'precache manifest in sw.js').toBeDefined()
  const current = JSON.parse(JSON.parse(literal ?? '""') as string) as Precache
  const next: Precache = { version, urls: [...current.urls, ADDED], lazy: current.lazy }
  const body = script.replace(literal ?? '', JSON.stringify(JSON.stringify(next)))
  await context.route(/\/sw\.js\?next$/, async (route) =>
    route.fulfill({ body, contentType: 'text/javascript', headers: { 'cache-control': 'no-cache' } }),
  )
  return next.urls
}

/** Paths the service workers fetch from the network, in order. */
function workerRequests(context: BrowserContext): string[] {
  const paths: string[] = []
  context.on('request', (request) => {
    if (request.serviceWorker() !== null) {
      paths.push(new URL(request.url()).pathname)
    }
  })
  return paths
}

const sorted = (paths: string[]) => paths.toSorted((a, b) => a.localeCompare(b))

const cacheNames = async (page: Page) => page.evaluate(async () => caches.keys())

test('a new worker copies the hashed files it already has and fetches only the rest', async ({
  page,
  context,
  request,
}) => {
  await controlledPage(page)
  expect(await cacheNames(page)).toEqual([expect.stringMatching(/^seti-shell-/)])
  const urls = await serveNextWorker(context, request, 'e2e-next')
  await context.route(new RegExp(`${ADDED}$`), async (route) =>
    route.fulfill({ body: 'export {}', contentType: 'text/javascript' }),
  )
  const fetched = workerRequests(context)

  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js?next')
  })
  const toast = toasts(page).filter({ hasText: 'Seti updated' })
  await expect(toast).toBeVisible()

  const unhashed = urls.filter((url) => !url.startsWith('/assets/'))
  expect(sorted(fetched.filter((path) => path !== '/sw.js'))).toEqual(sorted([...unhashed, ADDED]))
  const held = await page.evaluate(async () => {
    const cache = await caches.open('seti-shell-e2e-next')
    return (await cache.keys()).map((entry) => new URL(entry.url).pathname)
  })
  expect(sorted(held)).toEqual(sorted(urls))

  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Reload' }).click()])
  await expect.poll(async () => cacheNames(page)).toEqual(['seti-shell-e2e-next'])
})

test('a failed fetch fails the install and the old worker keeps its cache', async ({ page, context, request }) => {
  await controlledPage(page)
  const before = await cacheNames(page)
  await serveNextWorker(context, request, 'e2e-broken')
  await context.route(new RegExp(`${ADDED}$`), async (route) => route.fulfill({ status: 500 }))

  const state = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register('/sw.js?next')
    const worker = registration.installing
    if (worker === null) {
      return 'not installing'
    }
    return new Promise<string>((resolve) => {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'redundant' || worker.state === 'installed') {
          resolve(worker.state)
        }
      })
    })
  })
  expect(state).toBe('redundant')
  expect(await cacheNames(page)).toEqual(before)
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')).toMatch(/\/sw\.js$/)
  await page.reload()
  await expect(page.getByRole('banner')).toBeVisible()
})
