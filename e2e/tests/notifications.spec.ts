import type { APIRequestContext, Page } from '@playwright/test'
import { DEFAULT_TIERS, type Envelope, type Task } from '@seti/shared'
import { openAgentSettings } from './support/agent-settings.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { mockPushManager, PUSH_ENV, startPushService, type PushService } from './support/push.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...PUSH_ENV }, failureToasts: true })

let service: PushService

test.beforeEach(async ({ page }) => {
  service = await startPushService()
  await mockPushManager(page, service)
})

test.afterEach(async ({ request }) => {
  await request.put('/api/notifications/settings', { data: DEFAULT_TIERS })
  const { devices } = await apiData<{ devices: { device_id: string }[] }>(request, '/notifications')
  for (const device of devices) {
    await request.delete(`/api/notifications/devices/${device.device_id}`)
  }
  await service.close()
})

const main = (page: Page) => page.getByRole('main')
const toggle = (page: Page, name: string) => main(page).getByRole('button', { name, exact: true })
const tier = (page: Page, name: string) => main(page).getByRole('combobox', { name: `${name} tier` })
const pushesFor = (id: string) => service.pushes.filter((push) => push.payload.tag === id)

async function turnOnPush(page: Page): Promise<void> {
  await page.goto('/#settings/notifications')
  await expect(toggle(page, 'Push')).toHaveAttribute('aria-pressed', 'false')
  await toggle(page, 'Push').click()
  await expect(toasts(page).filter({ hasText: 'Push on for this device' })).toBeVisible()
  await expect(toggle(page, 'Push')).toHaveAttribute('aria-pressed', 'true')
}

async function finishAgent(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.post('/api/tasks', {
    data: { title, prompt: `Say hello for ${title}`, cwd: paths.checkout, sandbox: false },
  })
  expect(response.ok(), 'POST /api/tasks').toBe(true)
  const { id } = ((await response.json()) as Envelope<Task>).data
  await expect.poll(async () => (await apiData<Task>(request, `/tasks/${id}`)).status).toBe('idle')
  return id
}

async function sendAndFinish(request: APIRequestContext, id: string): Promise<void> {
  const before = (await apiData<Task>(request, `/tasks/${id}`)).updated_at
  const sent = await request.post(`/api/tasks/${id}/messages`, { data: { prompt: 'Say hello again' } })
  expect(sent.ok(), 'POST messages').toBe(true)
  await expect
    .poll(async () => {
      const task = await apiData<Task>(request, `/tasks/${id}`)
      return task.status === 'idle' && task.updated_at !== before
    })
    .toBe(true)
}

interface FocusReport {
  agents: string[]
  active: boolean
}

/** Waits until the server answered a focus report that `matches`. */
async function focusReported(page: Page, matches: (report: FocusReport) => boolean): Promise<void> {
  await page.waitForResponse((res) => {
    const req = res.request()
    return req.url().endsWith('/api/notifications/focus') && matches(req.postDataJSON() as FocusReport)
  })
}

/** Hides the page as switching apps does, so it stops reporting and pushes reach this device. */
async function hidePage(page: Page): Promise<void> {
  const left = focusReported(page, (report) => !report.active && report.agents.length === 0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await left
}

test('push turns on with permission, a test arrives, and settings stick', async ({ page }) => {
  await turnOnPush(page)
  const devices = main(page).getByRole('region', { name: 'Push devices' })
  await expect(devices).toContainText('(this device)')

  await toggle(page, 'Test push').click()
  await expect(toasts(page).filter({ hasText: 'Test sent' })).toBeVisible()
  await expect.poll(() => service.pushes.length).toBe(1)
  const [sent] = service.pushes
  expect(sent?.payload).toMatchObject({ title: 'Seti', kind: 'test', url: '/#settings/notifications' })
  expect(sent?.headers).toMatchObject({ topic: 'seti-test', urgency: 'high', 'content-encoding': 'aes128gcm' })
  expect(sent?.headers.authorization).toMatch(/^vapid t=/)

  await tier(page, 'Active').click()
  await page.getByRole('option', { name: 'Brief' }).click()
  await expect(tier(page, 'Active')).toHaveText('Brief')
  await toggle(page, 'Sound').click()
  await expect(toggle(page, 'Sound')).toHaveAttribute('aria-pressed', 'false')
  await page.reload()
  await expect(tier(page, 'Active')).toHaveText('Brief')
  await expect(tier(page, 'Urgent')).toHaveText('Push')
  await tier(page, 'Urgent').click()
  await expect(page.getByRole('option')).toHaveText(['Push', 'Toast'])
  await page.keyboard.press('Escape')
  await expect(toggle(page, 'Sound')).toHaveAttribute('aria-pressed', 'false')

  await devices.getByRole('button', { name: /^Remove / }).click()
  await expect(devices).toContainText('No device gets push yet.')
  await expect(toggle(page, 'Push')).toHaveAttribute('aria-pressed', 'false')
})

test('a finished turn off screen toasts its closing line, and pushes once the page is hidden', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000)
  await turnOnPush(page)
  await page.goto('/#context')
  const shownTitle = unique('Toast finished')
  const shown = await finishAgent(request, shownTitle)
  const toast = toasts(page).filter({ hasText: shownTitle })
  await expect(toast).toContainText('done')
  await expect(toast).not.toContainText('Finished')
  expect(pushesFor(shown)).toEqual([])

  const viewing = focusReported(page, (report) => report.agents.includes(shown))
  await toast.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${shown}$`))
  await viewing

  await hidePage(page)
  const away = await finishAgent(request, unique('Push finished'))
  await expect.poll(() => pushesFor(away).length).toBe(1)
  expect(pushesFor(away)[0]?.payload).toMatchObject({ kind: 'finished', body: 'done', url: `/#agents/${away}` })
  expect(pushesFor(away)[0]?.headers).toMatchObject({ urgency: 'normal', topic: away.replaceAll('-', '') })
})

test('a muted agent raises no toast or push, and the cog unmutes it', async ({ page, request }) => {
  test.setTimeout(90_000)
  const quietTitle = unique('Muted agent')
  const quiet = await finishAgent(request, quietTitle)
  await turnOnPush(page)
  await page.goto(`/#agents/${quiet}`)
  const general = await openAgentSettings(page)
  const notify = general.getByRole('button', { name: 'Notify', exact: true })
  await expect(notify).toHaveAttribute('aria-pressed', 'true')
  await notify.click()
  await expect(notify).toHaveAttribute('aria-pressed', 'false')
  expect((await apiData<Task>(request, `/tasks/${quiet}`)).notifications_muted).toBe(true)
  await page.keyboard.press('Escape')

  await page.goto('/#context')
  await sendAndFinish(request, quiet)
  const loudTitle = unique('Loud agent')
  await finishAgent(request, loudTitle)
  await expect(toasts(page).filter({ hasText: loudTitle })).toBeVisible()
  await expect(toasts(page).filter({ hasText: quietTitle })).toHaveCount(0)

  await hidePage(page)
  await sendAndFinish(request, quiet)
  const loud = await finishAgent(request, unique('Loud pushed'))
  await expect.poll(() => pushesFor(loud).length).toBe(1)
  expect(pushesFor(quiet)).toEqual([])

  await page.goto(`/#agents/${quiet}`)
  const again = (await openAgentSettings(page)).getByRole('button', { name: 'Notify', exact: true })
  await again.click()
  await expect(again).toHaveAttribute('aria-pressed', 'true')
})
