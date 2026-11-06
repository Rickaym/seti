import type { Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { expectClear, homeScreenApp, PORTRAIT, recordBadges, safeAreas } from './support/ios.js'
import { edgesAtRest, expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { mockPushManager, PUSH_ENV, startPushService, type PushService } from './support/push.js'
import { terminalIn, terminalInput } from './support/terminal.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...PUSH_ENV } })

let service: PushService

test.beforeEach(async ({ page }) => {
  service = await startPushService()
  await mockPushManager(page, service)
})

test.afterEach(async ({ request }) => {
  const { devices } = await apiData<{ devices: { device_id: string }[] }>(request, '/notifications')
  for (const device of devices) {
    await request.delete(`/api/notifications/devices/${device.device_id}`)
  }
  await service.close()
})

const main = (page: Page) => page.getByRole('main')
const pushToggle = (page: Page) => main(page).getByRole('button', { name: 'Push', exact: true })
const statusBar = (page: Page) => page.getByRole('contentinfo')

/** Seeds an agent whose failed turn the user has not seen, so it waits in Needs you. */
async function seedFailedAgent(): Promise<string> {
  const db = openSeedDb()
  const id = crypto.randomUUID()
  try {
    await db.idleTask(id, unique('Failed on iPhone'), paths.checkout, new Date().toISOString())
    await db.run(`UPDATE task SET status = 'error', last_error = 'exit 1', unseen = true WHERE id = ?`, id)
  } finally {
    await db.close()
  }
  return id
}

async function markSeen(id: string): Promise<void> {
  const db = openSeedDb()
  try {
    await db.run('UPDATE task SET unseen = false WHERE id = ?', id)
  } finally {
    await db.close()
  }
}

test('Safari on iPhone says push needs the Home Screen; Android asks for nothing', async ({ page }, info) => {
  await page.goto('/#settings/notifications')
  const hint = main(page).getByRole('region', { name: 'Add to Home Screen' })
  if (info.project.name !== 'iphone-15') {
    await expect(pushToggle(page)).toBeEnabled()
    await expect(hint).toHaveCount(0)
    return
  }
  await expect(hint).toContainText('Add to Home Screen, then Add')
  await expect(pushToggle(page)).toBeDisabled()
  await expect(main(page)).toContainText('only Seti on the Home Screen gets push')
  await expectFitsPhone(page, 'notifications with the Home Screen hint')
})

test('the Home Screen app asks for push on the tap and toasts above the home indicator', async ({ page }) => {
  await homeScreenApp(page)
  await safeAreas(page, PORTRAIT)
  await page.goto('/#settings/notifications')
  await expect(main(page).getByRole('region', { name: 'Add to Home Screen' })).toHaveCount(0)
  await pushToggle(page).scrollIntoViewIfNeeded()
  await pushToggle(page).tap()
  await expect(pushToggle(page)).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('html')).toHaveAttribute('data-permission-asked', 'on-tap')

  const toast = toasts(page).filter({ hasText: 'Push on for this device' })
  await expect(toast).toBeVisible()
  const shown = await edgesAtRest(page, toast)
  expect(shown.bottom).toBeLessThanOrEqual((await edgesAtRest(page, statusBar(page))).top)
})

test('the header, drawer and status bar clear the notch and the home indicator', async ({ page }) => {
  await safeAreas(page, PORTRAIT)
  await page.goto('/#agents')
  const menu = page.getByRole('banner').getByRole('button', { name: 'Menu' })
  await expectClear(page, menu, PORTRAIT, 'menu button')
  await expectClear(page, statusBar(page).getByRole('button').first(), PORTRAIT, 'status bar item')

  await menu.tap()
  const drawer = page.getByRole('dialog')
  await expectClear(page, drawer.getByRole('button').first(), PORTRAIT, 'first drawer item')
  await expectClear(page, drawer.getByRole('button').last(), PORTRAIT, 'last drawer item')
})

test('the terminal key bar sits on the status bar without a second inset', async ({ page }) => {
  await safeAreas(page, PORTRAIT)
  await page.goto('/#agents')
  await page.getByRole('button', { name: 'Menu' }).tap()
  await page.getByRole('dialog').getByRole('button', { name: 'Terminal' }).tap()
  const terminal = terminalIn(page)
  await expect(terminalInput(terminal)).toBeAttached()
  const keys = terminal.getByRole('toolbar', { name: 'Terminal keys' })
  await expect(keys).toBeVisible()
  const key = keys.getByRole('button').first()
  const [keyBox, barBox] = await Promise.all([key.boundingBox(), statusBar(page).boundingBox()])
  const gap = (barBox?.y ?? 0) - ((keyBox?.y ?? 0) + (keyBox?.height ?? 0))
  expect(gap).toBeGreaterThanOrEqual(0)
  expect(gap).toBeLessThan(PORTRAIT.bottom / 2)
  await expectClear(page, key, PORTRAIT, 'first terminal key')
})

test('the app badge follows the Needs you count', async ({ page }) => {
  const badges = await recordBadges(page)
  const id = await seedFailedAgent()
  try {
    await page.goto('/#agents')
    const item = statusBar(page).getByRole('button', { name: /agents? needs? you/ })
    await expect(item).toBeVisible()
    const count = Number((await item.textContent())?.match(/\d+/)?.[0])
    await expect.poll(async () => (await badges()).at(-1)).toBe(count)
    await markSeen(id)
    await expect.poll(async () => (await badges()).at(-1), { timeout: 20_000 }).toBe(count - 1)
  } finally {
    await markSeen(id)
  }
})

test('the Needs you shortcut opens Seti on the Needs you group', async ({ page }) => {
  const id = await seedFailedAgent()
  try {
    await page.addInitScript(() => {
      localStorage.setItem('seti.agents.needs-you.collapsed', '1')
    })
    await page.goto('/?view=needs-you')
    const group = main(page).getByRole('region', { name: 'Needs you' })
    await expect(group.getByRole('button', { name: /^Needs you/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(group.locator(`[data-task-id="${id}"]`)).toBeVisible()
    expect(new URL(page.url()).search).toBe('')
  } finally {
    await markSeen(id)
  }
})
