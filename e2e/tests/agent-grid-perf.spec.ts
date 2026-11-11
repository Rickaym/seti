import type { Locator, Page, Request } from '@playwright/test'
import type { PullRequest } from '@seti/shared'
import { seedLongTranscript } from './support/chat-search.js'
import { expect, test, unique } from './support/fixtures.js'
import {
  GRID_AGENTS,
  gridStorage,
  installProbe,
  LARGE_ROW_AGENTS,
  readProbe,
  seedGridAgents,
  seedLargeRowAgents,
  startCounting,
  type ProbeReading,
} from './support/grid-perf.js'
import { startH2Proxy } from './support/h2-proxy.js'

/** Seti is reached over HTTP/2 through its tunnel, so every panel streams; the cert is ad hoc. */
test.use({ ignoreHTTPSErrors: true })

/** Most requests a panel makes as it opens: its stream, rewinds, one PR lookup and its asides. */
const PANEL_REQUESTS = 4

/** Well above what a panel renders as the grid opens, and well below the cost it once had. */
const PANEL_RENDERS = 1500

/** A slower CPU stands in for a weaker machine; the long-task budget leaves room for busy CI. */
const THROTTLE = 4
const WORST_LONG_TASK_MS = 2500

/** Rounds of task list polls to wait through for a quiet one, when other agents change. */
const QUIET_TRIES = 6

function openPr(url: string): PullRequest {
  const [, slug = '', number = '0'] = /github\.com\/(.+)\/pull\/(\d+)$/.exec(url) ?? []
  return {
    key: url,
    repo_id: slug,
    repo_slug: slug,
    number: Number(number),
    title: `Change ${number}`,
    url,
    draft: false,
    author: 'e2e',
    head_ref: `feat/${number}`,
    base_ref: 'main',
    head_oid: 'abc1234def',
    updated_at: new Date().toISOString(),
    review_decision: null,
    mergeable: 'mergeable',
    labels: [],
    ci: number === '3' ? 'failure' : 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    tasks: [],
    related: [],
  }
}

/** API requests that belong to one agent: its own routes, mods' routes for it and its PR lookups. */
function agentOf(request: Request, ids: readonly string[]): string | null {
  const { pathname } = new URL(request.url())
  const own = ids.find(
    (id) =>
      pathname.startsWith(`/api/tasks/${id}/`) || /^\/api\/mods\/[^/]+\/tasks\/([^/]+)\//.exec(pathname)?.[1] === id,
  )
  if (own !== undefined) {
    return own
  }
  if (pathname !== '/api/prs/lookup') {
    return null
  }
  const body = request.postData() ?? ''
  return ids.find((_id, index) => body.includes(`/e2e/grid${String(index)}/`)) ?? null
}

function trackAgentRequests(page: Page, ids: readonly string[]) {
  let seen: string[] = []
  page.on('request', (request) => {
    const agent = agentOf(request, ids)
    if (agent !== null) {
      seen.push(`${agent} ${request.method()} ${request.url()} ${request.postData() ?? ''}`)
    }
  })
  return {
    take: () => {
      const taken = seen
      seen = []
      return taken
    },
  }
}

function expectFewRequests(requests: readonly string[], ids: readonly string[]): void {
  const repeated = requests.filter((request, index) => requests.indexOf(request) !== index)
  expect(repeated, 'requests an agent made twice').toEqual([])
  for (const id of ids) {
    const own = requests.filter((request) => request.startsWith(`${id} `))
    expect(own.length, `requests of agent ${id}`).toBeLessThanOrEqual(PANEL_REQUESTS)
  }
}

const panelsWithRows = async (page: Page) =>
  page
    .locator('[data-grid-panel] [data-message-id]')
    .evaluateAll((rows) => new Set(rows.map((row) => row.closest('[data-grid-panel]'))).size)

/** The body of the next task list poll, or null when it answered 304 for the list it held. */
async function taskListPoll(page: Page): Promise<string | null> {
  const response = await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/tasks')
  return response.status() === 304 ? null : response.text()
}

const changed = (body: string | null, before: string | null) => body !== null && body !== before

/** Panel renders across two task list polls that brought the same list as the one before. */
async function quietPoll(page: Page): Promise<Record<string, number>> {
  let before = await taskListPoll(page)
  for (let tries = 0; tries < QUIET_TRIES; tries++) {
    const since = await startCounting(page)
    const first = await taskListPoll(page)
    const second = await taskListPoll(page)
    if (!changed(first, before) && !changed(second, first ?? before)) {
      return (await readProbe(page, since)).renders
    }
    before = second ?? first ?? before
  }
  throw new Error('the task list kept changing while the grid sat idle')
}

function expectLightRenders(reading: ProbeReading, when: string): void {
  const counts = Object.values(reading.renders)
  test.info().annotations.push({ type: when, description: JSON.stringify(reading) })
  expect(counts, 'panels that rendered').toHaveLength(GRID_AGENTS)
  const mean = counts.reduce((sum, n) => sum + n, 0) / counts.length
  expect(mean, 'components rendered per panel').toBeLessThan(PANEL_RENDERS)
  expect(reading.longTasks.worstMs, 'worst long task').toBeLessThan(WORST_LONG_TASK_MS)
}

test('nine agents open in the grid with one request of each kind, light renders and quiet idle panels', async ({
  page,
  setiServer,
}) => {
  test.setTimeout(120_000)
  const proxy = await startH2Proxy(setiServer.baseURL)
  try {
    const ids = await seedGridAgents()
    await page.route(/\/api\/prs\/lookup$/, async (route) => {
      const { urls } = route.request().postDataJSON() as { urls: string[] }
      await route.fulfill({ json: { data: urls.map(openPr), meta: {} } })
    })
    await page.addInitScript(installProbe)
    await page.addInitScript((stored) => {
      try {
        if (sessionStorage.getItem('grid-perf') === null) {
          sessionStorage.setItem('grid-perf', '1')
          localStorage.setItem('seti.agents.grid', stored)
        }
      } catch {
        // Pages without storage, such as about:blank, keep no grid.
      }
    }, gridStorage(ids))
    const requests = trackAgentRequests(page, ids)

    await page.goto(`${proxy.origin}/#context`)
    await expect(page.getByRole('main').getByRole('heading', { name: 'Context' }).first()).toBeVisible()
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

    const opened = await startCounting(page)
    requests.take()
    await page.evaluate(() => {
      window.location.hash = '#agents'
    })
    await expect.poll(async () => panelsWithRows(page), { timeout: 60_000 }).toBe(GRID_AGENTS)
    expectLightRenders(await readProbe(page, opened), 'grid open')
    expectFewRequests(requests.take(), ids)

    expect(await quietPoll(page), 'panels re-rendered by a task list poll that changed nothing').toEqual({})
    expect(requests.take(), 'agent requests while idle').toEqual([])

    await page.getByRole('main').getByRole('heading', { name: 'Grid perf 2', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`#agents/${ids[1] ?? ''}$`))
    await page.keyboard.press('Alt+g')
    await expect(page.locator('[data-grid-panel]')).toHaveCount(0)
    await expect(page.getByRole('main').locator('[data-message-id]').first()).toBeVisible()
    requests.take()
    const toggled = await startCounting(page)
    await page.keyboard.press('Alt+g')
    await expect.poll(async () => panelsWithRows(page), { timeout: 60_000 }).toBe(GRID_AGENTS)
    expectLightRenders(await readProbe(page, toggled), 'grid toggled back')
    expectFewRequests(requests.take(), ids)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  } finally {
    await page.goto('about:blank')
    await proxy.close()
  }
})

test('a grid panel renders its newest rows and reveals the loaded rest by scrolling up or by search', async ({
  page,
}) => {
  test.setTimeout(60_000)
  const id = await seedLongTranscript(unique('Grid window'), unique('needle'))
  const pages: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname === `/api/tasks/${id}/messages`) {
      pages.push(url.search)
    }
  })
  const whole = { i: 'p1', agent: id, x: 0, y: 0, w: 12, h: 24 }
  const stored = JSON.stringify({ v: 2, enabled: true, panels: [whole], locked: false, focused: 'p1', recent: [] })
  await page.addInitScript((grid) => {
    localStorage.setItem('seti.agents.grid', grid)
  }, stored)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })
  await page.goto('/#agents')
  const panel = page.locator('[data-grid-panel]')
  const transcript = panel.getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('Reply 3000 done')).toBeVisible()
  expect(await transcript.locator('[data-message-id]').count()).toBeLessThanOrEqual(60)
  await expect(transcript.getByText('Turn 2950: keep going')).toHaveCount(0)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })

  await expect
    .poll(async () => {
      await transcript.evaluate((element) => {
        element.scrollTo({ top: 0 })
      })
      return transcript.getByText('Turn 2950: keep going').count()
    })
    .toBe(1)
  expect(pages, 'pages fetched for rows already loaded').toEqual([])

  await page.reload()
  await expect(transcript.getByText('Reply 3000 done')).toBeVisible()
  await panel.getByRole('heading').first().click()
  await page.keyboard.press('Control+f')
  await page.keyboard.type('Turn 2940:')
  await expect(panel.getByTestId('chat-find-count')).toHaveText('1 of 1')
  await expect(panel.locator('[data-find-current]')).toContainText('Turn 2940: keep going')
  await expect(panel.locator('[data-find-current]')).toBeInViewport()
})

/** At a pixel ratio of 1, Chrome scrolls a box on the compositor only if its background is opaque. */
const backgroundAlpha = async (locator: Locator) =>
  locator.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')
    if (context === null) {
      return -1
    }
    context.fillStyle = getComputedStyle(element).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return context.getImageData(0, 0, 1, 1).data[3] ?? -1
  })

/** A few renders as the message nav and the unseen count appear, far below one per own message. */
const SCROLL_RENDERS = 120
const SCROLL_STEP_PX = 120
const MIN_PASSED = 5
/** Stays clear of the top, where scrolling reveals earlier rows and renders them. */
const SCROLL_FLOOR_PX = 600

test('a grid panel scrolls on the compositor and renders nothing as your own messages pass', async ({ page }) => {
  const id = await seedLongTranscript(unique('Grid scroll'), unique('needle'))
  await page.addInitScript(installProbe)
  const whole = { i: 'p1', agent: id, x: 0, y: 0, w: 12, h: 24 }
  const stored = JSON.stringify({ v: 2, enabled: true, panels: [whole], locked: false, focused: 'p1', recent: [] })
  await page.addInitScript((grid) => {
    localStorage.setItem('seti.agents.grid', grid)
  }, stored)
  await page.goto('/#agents')
  const transcript = page.locator('[data-grid-panel]').getByRole('region', { name: 'Transcript' })
  await expect(transcript.getByText('Reply 3000 done')).toBeInViewport()
  expect(await backgroundAlpha(page.getByTestId('agent-grid')), 'grid background alpha').toBe(255)
  expect(await backgroundAlpha(transcript), 'transcript background alpha').toBe(255)

  const since = await startCounting(page)
  const passed = await transcript.evaluate(
    async (element, { step, floor }) => {
      const frame = async () =>
        new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        })
      const asks = () => element.querySelectorAll('[data-own-message]')
      const above = () =>
        [...asks()].filter((ask) => ask.getBoundingClientRect().top < element.getBoundingClientRect().top).length
      const start = above()
      while (element.scrollTop - step > floor) {
        element.scrollBy(0, -step)
        await frame()
      }
      return start - above()
    },
    { step: SCROLL_STEP_PX, floor: SCROLL_FLOOR_PX },
  )
  expect(passed, 'own messages the scroll passed').toBeGreaterThan(MIN_PASSED)
  const reading = await readProbe(page, since)
  expect(reading.renders.p1 ?? 0, 'components rendered by the scroll').toBeLessThan(SCROLL_RENDERS)
})

/** Well above a grid of three such agents, which holds about 30 MB, and far below a stuck tab. */
const LARGE_ROWS_HEAP_MB = 150
/** Tool text reaches the browser cut to 16 KB, so a backlog stays far below its 4 MB of rows. */
const LARGE_ROWS_BACKLOG_KB = 512

/** Bytes each agent's stream has received so far, by task id. */
async function trackStreamBytes(page: Page): Promise<() => Record<string, number>> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const streams = new Map<string, string>()
  const bytes: Record<string, number> = {}
  cdp.on('Network.requestWillBeSent', ({ requestId, request }) => {
    const id = /\/api\/tasks\/([^/]+)\/stream$/.exec(new URL(request.url).pathname)?.[1]
    if (id !== undefined) {
      streams.set(requestId, id)
    }
  })
  cdp.on('Network.dataReceived', ({ requestId, dataLength }) => {
    const id = streams.get(requestId)
    if (id !== undefined) {
      bytes[id] = (bytes[id] ?? 0) + dataLength
    }
  })
  return () => ({ ...bytes })
}

const usedHeapMb = async (page: Page) =>
  page.evaluate(() => {
    const { memory } = performance as Performance & { memory: { usedJSHeapSize: number } }
    return memory.usedJSHeapSize / 1024 / 1024
  })

test('agents with megabyte tool results and long cd commands open in the grid at a bounded cost', async ({ page }) => {
  test.setTimeout(60_000)
  const ids = await seedLargeRowAgents()
  await page.addInitScript(installProbe)
  await page.addInitScript((stored) => {
    localStorage.setItem('seti.agents.grid', stored)
  }, gridStorage(ids))
  const streamBytes = await trackStreamBytes(page)

  await page.goto('/#agents')
  await expect.poll(async () => panelsWithRows(page), { timeout: 15_000 }).toBe(LARGE_ROW_AGENTS)
  for (const [index] of ids.entries()) {
    await expect(page.getByText(`Large rows ${String(index + 1)} settled.`)).toBeVisible()
  }

  const reading = await readProbe(page, 0)
  expect(reading.longTasks.worstMs, 'worst long task').toBeLessThan(WORST_LONG_TASK_MS)
  expect(await usedHeapMb(page), 'JS heap in MB').toBeLessThan(LARGE_ROWS_HEAP_MB)
  const bytes = streamBytes()
  for (const id of ids) {
    expect((bytes[id] ?? 0) / 1024, `stream KB of agent ${id}`).toBeLessThan(LARGE_ROWS_BACKLOG_KB)
  }
})
