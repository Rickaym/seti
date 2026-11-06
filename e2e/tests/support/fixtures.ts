import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type Response,
  type Route,
} from '@playwright/test'
import type { Envelope, Repo } from '@seti/shared'
import { openSeedDb } from './db.js'
import { paths, USER_HEADERS } from './env.js'
import { startDemoServer, startWorkerServer, type WorkerServer } from './server.js'

const FAILED_RESOURCE = /^Failed to load resource: the server responded with a status of \d{3}/

/** Containers starting on the shared host add interfaces, and Chromium drops connects on each. */
const NETWORK_CHANGED = /^Failed to load resource: net::ERR_NETWORK_CHANGED$/

/** An HTML preview keeps a page's scripts off by default, and Chromium logs each one it stops. */
const PREVIEW_SCRIPTS_OFF =
  /^Blocked script execution in '[^']*\/files\/raw\?[^']*preview=1[^']*' because the document's frame is sandboxed/

const CSP_BINDING = 'setiCspViolation'

/** Chromium logs no console error for some violations, such as a caught eval, so listen for all. */
function reportCspViolations(binding: string): void {
  document.addEventListener('securitypolicyviolation', (event) => {
    const report = Reflect.get(window, binding) as ((text: string) => Promise<void>) | undefined
    void report?.(`${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${String(event.lineNumber)}`)
  })
}

/** Seti closes keep-alive sockets idle for 5 s, and Node may reuse one just as it closes. */
const STALE_SOCKET = /\b(ECONNRESET|socket hang up)\b/

/** Sends the request again on a fresh socket when the reused one was closed, as browsers do. */
async function fetchOnLiveSocket(route: Route): Promise<APIResponse> {
  try {
    return await route.fetch()
  } catch (e) {
    if (e instanceof Error && STALE_SOCKET.test(e.message)) {
      return route.fetch()
    }
    throw e
  }
}

/** A chunk import that a host network change aborted stays failed, so assets load through Node. */
export async function loadAssetsThroughNode(context: BrowserContext, baseURL: string): Promise<void> {
  const isAsset = (url: URL) => url.origin === baseURL && url.pathname.startsWith('/assets/')
  await context.route(isAsset, async (route) => route.fulfill({ response: await fetchOnLiveSocket(route) }))
}

/** Failure toasts only raise failures after this time, so a far future keeps them quiet. */
function silenceFailureToasts(): void {
  try {
    localStorage.setItem('seti.failures.since', '9999-12-31T00:00:00.000Z')
  } catch {
    // Storage can be blocked; toasts then follow the page's own baseline.
  }
}

interface Fixtures {
  /** HTTP error statuses a test provokes on purpose. Any other status of 400 or above fails it. */
  allowedHttpStatuses: number[]
  /** Console errors a test provokes on purpose, such as a crash a boundary catches. */
  allowedConsoleErrors: RegExp[]
  /** CSP violations a test provokes on purpose, such as a sandboxed page reaching for the web. */
  allowedCspViolations: RegExp[]
  /** Failure toasts stay off unless a spec turns them on, since many specs leave failed agents. */
  failureToasts: boolean
  failOnBrowserErrors: undefined
  leaveFocus: undefined
  assetsOutsideChromium: undefined
  emptyGrids: undefined
}

interface WorkerFixtures {
  /** Environment for this worker's Seti, a worker of its own per value; SETI_DEMO=1 runs the demo. */
  serverEnv: NodeJS.ProcessEnv
  /** This worker's own Seti, started before any hook so seeding helpers find its database. */
  setiServer: WorkerServer
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  serverEnv: [{}, { scope: 'worker', option: true }],
  setiServer: [
    async ({ serverEnv }, use) => {
      const server = await (serverEnv.SETI_DEMO === '1' ? startDemoServer() : startWorkerServer(serverEnv))
      await use(server)
      await server.close()
    },
    { scope: 'worker', auto: true, timeout: 90_000 },
  ],
  baseURL: async ({ setiServer }, use) => {
    await use(setiServer.baseURL)
  },
  /** The browser and API requests act as a signed-in local user; the sign-in spec opts out. */
  extraHTTPHeaders: USER_HEADERS,
  /** API calls each take a fresh socket, since a reused idle one can close as the call goes out. */
  request: async ({ playwright, baseURL, extraHTTPHeaders }, use) => {
    const request = await playwright.request.newContext({
      ...(baseURL === undefined ? {} : { baseURL }),
      extraHTTPHeaders: { ...extraHTTPHeaders, connection: 'close' },
    })
    await use(request)
    await request.dispose()
  },
  allowedHttpStatuses: [[], { option: true }],
  allowedConsoleErrors: [[], { option: true }],
  allowedCspViolations: [[], { option: true }],
  failureToasts: [false, { option: true }],
  assetsOutsideChromium: [
    async ({ context, serviceWorkers, setiServer }, use) => {
      if (serviceWorkers === 'block') {
        await loadAssetsThroughNode(context, setiServer.baseURL)
      }
      await use(undefined)
    },
    { auto: true },
  ],
  /** Grids live on the server, so each test starts with none, as a fresh browser once did. */
  emptyGrids: [
    async ({ setiServer: _server, serverEnv }, use) => {
      if (serverEnv.SETI_DEMO === '1') {
        await use(undefined)
        return
      }
      const db = openSeedDb()
      await db.run('DELETE FROM workspace_grid')
      await db.close()
      await use(undefined)
    },
    { auto: true },
  ],
  /** Closing a context fires no pagehide, so each test's page leaves as a closed tab would. */
  leaveFocus: [
    async ({ page, baseURL, serverEnv }, use) => {
      await use(undefined)
      const demo = serverEnv.SETI_DEMO === '1'
      if (demo || page.isClosed() || baseURL === undefined || !page.url().startsWith(baseURL)) {
        return
      }
      const isFocus = (url: string) => url.endsWith('/api/notifications/focus')
      const left = page.waitForRequest((req) => isFocus(req.url()), { timeout: 1000 }).catch(() => null)
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))).catch(() => undefined)
      await left
    },
    { auto: true },
  ],
  failOnBrowserErrors: [
    async ({ page, allowedHttpStatuses, allowedConsoleErrors, allowedCspViolations, failureToasts }, use) => {
      if (!failureToasts) {
        await page.addInitScript(silenceFailureToasts)
      }
      const errors: string[] = []
      page.on('pageerror', (error) => {
        errors.push(`uncaught: ${error.message}`)
      })
      page.on('response', (response) => {
        const status = response.status()
        if (status >= 400 && !allowedHttpStatuses.includes(status)) {
          const { pathname } = new URL(response.url())
          errors.push(`http: ${String(status)} ${response.request().method()} ${pathname}`)
        }
      })
      page.on('console', (message) => {
        const text = message.text()
        const expected = [FAILED_RESOURCE, NETWORK_CHANGED, PREVIEW_SCRIPTS_OFF, ...allowedConsoleErrors].some(
          (known) => known.test(text),
        )
        if (message.type() === 'error' && !expected) {
          errors.push(`console: ${text}`)
        }
      })
      await page.exposeBinding(CSP_BINDING, (_source, violation: string) => {
        if (!allowedCspViolations.some((known) => known.test(violation))) {
          errors.push(`csp: ${violation}`)
        }
      })
      await page.addInitScript(reportCspViolations, CSP_BINDING)
      await use(undefined)
      expect(errors, 'browser errors').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }

export async function apiData<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api${path}`)
  expect(response.ok(), `GET /api${path}`).toBe(true)
  return ((await response.json()) as Envelope<T>).data
}

export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`

/** Registers both scratch checkouts under fresh slugs; remove them with removeRepos. */
export async function addScratchRepos(request: APIRequestContext): Promise<[Repo, Repo]> {
  const add = async (name: string, checkout: string) => {
    const response = await request.post('/api/repos', {
      data: { slug: `e2e/${unique(name)}`, path: checkout, base_branch: 'main' },
    })
    expect(response.ok(), 'POST /api/repos').toBe(true)
    return ((await response.json()) as Envelope<Repo>).data
  }
  return [await add('api', paths.checkout), await add('web', paths.secondCheckout)]
}

export async function removeRepos(request: APIRequestContext, repos: readonly Repo[]): Promise<void> {
  for (const repo of repos) {
    expect((await request.delete(`/api/repos/${repo.id}`)).ok()).toBe(true)
  }
}

export const toasts = (page: Page) => page.locator('[data-sonner-toast]')

/** Toasts sit over the top-right header buttons until they time out. */
export async function waitForToastsToClear(page: Page): Promise<void> {
  await expect(toasts(page)).toHaveCount(0, { timeout: 15_000 })
}

export async function nextApiResponse(page: Page, method: string, path: string): Promise<Response> {
  return page.waitForResponse(
    (response) => response.request().method() === method && new URL(response.url()).pathname === `/api${path}`,
  )
}
