import type { Locator, Page, Route } from '@playwright/test'
import type { Envelope, MessagePage } from '@seti/shared'
import { expect, test, unique } from './support/fixtures.js'
import { seedLoadingTask, sse, stream } from './support/transcript-loading.js'

test.use({ allowedHttpStatuses: [503] })

const skeleton = (page: Page) => page.getByRole('status', { name: 'Loading transcript' })
const transcript = (page: Page) => page.getByRole('region', { name: 'Transcript' })
const composer = (page: Page) => page.getByRole('combobox', { name: 'Reply' })
const listItem = (page: Page, title: string) => page.getByRole('button', { name: new RegExp(title) })

const box = async (locator: Locator) => {
  const found = await locator.boundingBox()
  return found === null ? null : { x: found.x, y: found.y, width: found.width, height: found.height }
}

const pause = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Records whether the transcript skeleton ever appears, however briefly. */
async function watchForSkeleton(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate(() => {
    const seen = () => document.querySelector('[aria-label="Loading transcript"]') !== null
    Reflect.set(window, 'skeletonSeen', seen())
    new MutationObserver(() => {
      if (seen()) {
        Reflect.set(window, 'skeletonSeen', true)
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  return async () => page.evaluate(() => Reflect.get(window, 'skeletonSeen') === true)
}

async function openList(page: Page, title: string): Promise<void> {
  await page.goto('/#agents')
  await expect(listItem(page, title)).toBeVisible()
}

test('a slow transcript shows the header at once, then a skeleton that rows replace in place', async ({ page }) => {
  const title = unique('Slow transcript')
  const { id, reply } = await seedLoadingTask(title)
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(stream(id), async (route) => {
    await held
    await route.continue()
  })
  await openList(page, title)
  await listItem(page, title).click()

  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
  await expect(skeleton(page)).toBeVisible()
  await expect(composer(page)).toBeVisible()
  const before = { pane: await box(transcript(page)), composer: await box(composer(page)) }

  release()
  await expect(transcript(page).getByText(reply)).toBeVisible()
  await expect(skeleton(page)).toHaveCount(0)
  expect({ pane: await box(transcript(page)), composer: await box(composer(page)) }).toEqual(before)
})

test('a load past eight seconds says the network is slow', async ({ page }) => {
  test.setTimeout(45_000)
  const title = unique('Very slow transcript')
  const { id, reply } = await seedLoadingTask(title)
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route(stream(id), async (route) => {
    await held
    await route.continue()
  })
  await page.goto(`/#agents/${id}`)
  await expect(skeleton(page)).toBeVisible()
  await expect(page.getByText('Still loading... (slow network)')).toHaveCount(0)
  await expect(page.getByText('Still loading... (slow network)')).toBeVisible({ timeout: 12_000 })
  release()
  await expect(transcript(page).getByText(reply)).toBeVisible()
  await expect(page.getByText('Still loading... (slow network)')).toHaveCount(0)
})

test('a quick transcript never flashes the skeleton, and a reconnect keeps the rows', async ({ page, request }) => {
  const title = unique('Quick transcript')
  const { id, reply } = await seedLoadingTask(title)
  const listed = await request.get(`/api/tasks/${id}/messages`)
  const { data } = (await listed.json()) as Envelope<MessagePage>
  const reconnects: Route[] = []
  await page.route(stream(id), async (route) => {
    if (reconnects.length === 0 && !route.request().url().includes('after=')) {
      reconnects.push(route)
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `retry: 300\n\n${sse('backlog', data, data.messages.at(-1)?.id)}`,
      })
      return
    }
    reconnects.push(route)
  })
  await openList(page, title)
  const skeletonSeen = await watchForSkeleton(page)
  await listItem(page, title).click()

  await expect(transcript(page).getByText(reply)).toBeVisible()
  await expect.poll(() => reconnects.length).toBeGreaterThan(1)
  await pause(500)
  await expect(transcript(page).getByText(reply)).toBeVisible()
  expect(await skeletonSeen()).toBe(false)
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('a failed load offers Retry, which loads the transcript', async ({ page }) => {
  const title = unique('Failing transcript')
  const { id, reply } = await seedLoadingTask(title)
  let failing = true
  await page.route(stream(id), async (route) => {
    await (failing ? route.fulfill({ status: 503, body: '' }) : route.continue())
  })
  await page.goto(`/#agents/${id}`)
  await expect(page.getByRole('main').getByRole('heading', { name: title })).toBeVisible()
  const alert = page.getByRole('alert').filter({ hasText: 'Could not load the transcript.' })
  await expect(alert).toBeVisible()
  await expect(skeleton(page)).toHaveCount(0)

  failing = false
  await alert.getByRole('button', { name: 'Retry' }).click()
  await expect(transcript(page).getByText(reply)).toBeVisible()
  await expect(alert).toHaveCount(0)
})

test('switching back to an agent shows its cached transcript at once', async ({ page }) => {
  const first = unique('Cached first')
  const second = unique('Cached second')
  const a = await seedLoadingTask(first)
  const b = await seedLoadingTask(second)
  await openList(page, first)
  await listItem(page, first).click()
  await expect(transcript(page).getByText(a.reply)).toBeVisible()
  await listItem(page, second).click()
  await expect(transcript(page).getByText(b.reply)).toBeVisible()

  await page.route(stream(a.id), async (route) => {
    await pause(3000)
    await route.continue().catch(() => undefined)
  })
  const skeletonSeen = await watchForSkeleton(page)
  await listItem(page, first).click()
  await expect(transcript(page).getByText(a.reply)).toBeVisible({ timeout: 1000 })
  expect(await skeletonSeen()).toBe(false)
  await page.unrouteAll({ behavior: 'wait' })
})
