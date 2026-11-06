import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { Envelope, ModActionResult, Task, TeamMessage } from '@seti/shared'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect } from './support/fixtures.js'
import { outsideRequests } from './support/html-pages.js'
import { fixtureCopy, installFolder, removeMod } from './support/mod-fixtures.js'
import { framedApiOutcomes, VIEW_CONSOLE_ERRORS, VIEW_HTTP_STATUSES, VIEW_VIOLATIONS } from './support/mod-views.js'
import { sinkTest as test } from './support/sink-upstream.js'

test.use({
  allowedCspViolations: VIEW_VIOLATIONS,
  allowedConsoleErrors: VIEW_CONSOLE_ERRORS,
  allowedHttpStatuses: [...VIEW_HTTP_STATUSES, 409],
})

const VIEW = 'hostile-view'
const LOGIC = 'hostile-logic'

test.afterEach(async ({ request }) => {
  await removeMod(request, VIEW)
  await removeMod(request, LOGIC)
})

const region = (page: Page) => page.getByRole('region', { name: 'Hostile view mod: Hostile' })
const frameOf = (page: Page) => page.frameLocator('iframe[title="Hostile view: Hostile"]')

test('a hostile view reaches neither Seti nor the web, and flooding or leaving its page stops it', async ({
  page,
  request,
  baseURL,
}) => {
  await installFolder(request, fixtureCopy(VIEW))
  const outside = outsideRequests(page, baseURL ?? '')
  const framed = framedApiOutcomes(page)
  const calls: string[] = []
  page.on('request', (sent) => {
    if (sent.url().includes(`/api/mod-frames/${VIEW}/call`)) {
      calls.push(sent.postData() ?? '')
    }
  })
  await page.goto(`/#${VIEW}.hostile`)
  const frame = frameOf(page)
  const results = frame.locator('#out li')
  await expect(results).toHaveCount(17)
  for (const line of [
    'kept before load: null',
    'fetch: blocked',
    'xhr: blocked',
    'websocket: blocked',
    'eventsource: blocked',
    'image: blocked',
    'popup: blocked',
    'top: blocked',
    'parent: blocked',
    'storage: v',
    'webrtc: undefined undefined undefined',
    'injected: blocked',
    'forged: posted',
    'palette only: refused denied',
  ]) {
    await expect(results.filter({ hasText: new RegExp(`^${line.split(':')[0] ?? ''}:`) })).toHaveText(line)
  }
  await expect(results.filter({ hasText: /^cookie:/ })).toHaveText(/cookie: (?:blocked|empty)/)
  await expect(results.filter({ hasText: /^form:/ })).toHaveText(/form: (?:blocked|submitted)/)
  await expect(frame.locator('#violations')).toContainText('connect-src')
  expect([...outside.values()].filter((outcome) => outcome !== 'csp')).toEqual([])
  expect(new Set(framed.values())).toEqual(new Set(['csp']))
  expect(calls.filter((body) => !body.includes('"command"'))).toEqual([])
  const stored = await request.post(`/api/mod-frames/${VIEW}/call`, {
    data: { view: 'hostile', op: 'storage.keys' },
  })
  expect(((await stored.json()) as Envelope<{ value: string[] }>).data.value).toEqual([])

  await frame.getByRole('button', { name: 'Big' }).click()
  await expect(results.filter({ hasText: 'after big' })).toHaveText('after big: answered')
  await frame.getByRole('button', { name: 'Odd' }).click()
  await expect(results.filter({ hasText: 'after odd' })).toHaveText('after odd: answered')
  expect(calls.some((body) => body.includes('"big"'))).toBe(false)

  await frame.getByRole('button', { name: 'Flood' }).click()
  await expect(region(page).getByRole('status')).toHaveText(
    "Hostile view's view was stopped: it sent too many messages.",
  )
  await region(page).getByRole('button', { name: 'Reload' }).click()
  await expect(results.filter({ hasText: /^kept before load:/ })).toHaveText('kept before load: null')
  await frame.getByRole('button', { name: 'Leave to API' }).click()
  await expect(region(page).getByRole('status')).toHaveText(
    "Hostile view's view tried to leave its page and was stopped.",
  )
  const left = [...framed.values()].filter((outcome) => outcome !== 'csp')
  expect(left).toHaveLength(1)
  expect(left[0]).toMatch(/^(?:answered 403|net::ERR_BLOCKED_BY_RESPONSE)$/)

  await region(page).getByRole('button', { name: 'Reload' }).click()
  await frame.getByRole('button', { name: 'Leave to web' }).click()
  await expect(region(page).getByRole('status')).toHaveText(
    "Hostile view's view tried to leave its page and was stopped.",
  )
  expect([...outside.values()].filter((outcome) => outcome !== 'csp')).toEqual([])
})

test("another frame that replays the view's nonce gets no port, and the view keeps its own", async ({
  page,
  request,
}) => {
  await installFolder(request, fixtureCopy(VIEW))
  await page.goto(`/#${VIEW}.hostile`)
  await expect(frameOf(page).locator('#out li')).toHaveCount(17)
  const src = (await page.locator('iframe[title="Hostile view: Hostile"]').getAttribute('src')) ?? ''
  const nonce = /#n=([\w-]+)$/.exec(src)?.[1] ?? ''
  expect(nonce).not.toBe('')

  const id = randomUUID()
  const dir = path.join(paths.root, `replay-${id.slice(0, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'replay.html'),
    `<!doctype html><title>waiting</title><script>
      addEventListener('message', function (e) { if (e.data && e.data.seti === 'mod-port') document.title = 'got port' })
      parent.postMessage({ seti: 'mod-hello', v: 1, nonce: ${JSON.stringify(nonce)} }, '*')
      setTimeout(function () { if (document.title === 'waiting') document.title = 'no port' }, 1000)
    </script>`,
  )
  const db = openSeedDb()
  await db.idleTask(id, 'Replay', dir, new Date().toISOString())
  await db.close()
  await page.evaluate((url) => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.title = 'Replay'
    frame.src = url
    document.body.append(frame)
  }, `/api/tasks/${id}/files/raw?root=cwd&path=replay.html&preview=1&scripts=1`)
  await expect.poll(async () => page.frame({ url: /replay\.html/ })?.title()).toBe('no port')

  await frameOf(page).getByRole('button', { name: 'Big' }).click()
  await expect(frameOf(page).locator('#out li').filter({ hasText: 'after big' })).toHaveText('after big: answered')
})

test('a hostile mod is refused every escape from its logic sandbox and past its grants', async ({ request, sink }) => {
  await installFolder(request, fixtureCopy(LOGIC))
  const before = await apiData<Task[]>(request, '/tasks')
  const reached = sink.seen.length
  const ran = await request.post(`/api/mods/${LOGIC}/actions/escape`, { data: { args: {} } })
  expect(ran.status(), await ran.text()).toBe(200)
  const found = ((await ran.json()) as Envelope<ModActionResult>).data.result as Record<string, string>
  expect(found).toEqual({
    'global process': 'undefined',
    'global require': 'undefined',
    'global fetch': 'undefined',
    'global XMLHttpRequest': 'undefined',
    'global WebSocket': 'undefined',
    'global setTimeout': 'undefined',
    'global Deno': 'undefined',
    'global Bun': 'undefined',
    eval: 'threw',
    Function: 'threw',
    'async constructor': 'threw',
    'fetch plain http': 'denied',
    'fetch loopback': 'denied',
    'fetch localhost': 'denied',
    'fetch other host': 'denied',
    'fetch other port': 'denied',
    'fetch credentials in url': 'denied',
    'fetch metadata': 'denied',
    'forbidden header': 'denied',
    'connection not granted': 'denied',
    'tasks read': 'denied',
    'tasks stop': 'denied',
    'tasks start': 'denied',
    'direct to user': 'denied',
    'core notification': 'denied',
    'undeclared audit': 'denied',
    'undeclared status': 'denied',
    files: 'denied',
    'oversized storage': 'limit',
  })
  expect(sink.seen).toHaveLength(reached)
  expect(await apiData<Task[]>(request, '/tasks')).toHaveLength(before.length)
  const messages = await apiData<TeamMessage[]>(request, '/team/messages')
  expect(messages.filter((message) => message.text.includes('I am the user'))).toEqual([])
})
