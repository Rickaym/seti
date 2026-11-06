import { DEFAULT_TIERS } from '@seti/shared'
import { apiData, expect, test, toasts, unique } from './support/fixtures.js'
import { startAgent } from './support/grid.js'
import { homeScreenApp } from './support/ios.js'
import { expectFitsPhone } from './support/phone-layout.js'
import { FAKE_CLAUDE_ENV } from './support/processes.js'
import { mockPushManager, PUSH_ENV, startPushService, type PushService } from './support/push.js'

test.use({ serverEnv: { ...FAKE_CLAUDE_ENV, ...PUSH_ENV }, failureToasts: true })

let service: PushService

test.beforeEach(async ({ page }) => {
  service = await startPushService()
  await mockPushManager(page, service)
  await homeScreenApp(page)
})

test.afterEach(async ({ request }) => {
  await request.put('/api/notifications/settings', { data: DEFAULT_TIERS })
  const { devices } = await apiData<{ devices: { device_id: string }[] }>(request, '/notifications')
  for (const device of devices) {
    await request.delete(`/api/notifications/devices/${device.device_id}`)
  }
  await service.close()
})

test('the phone turns on push, sends a test and changes where a tier goes', async ({ page }) => {
  await page.goto('/#settings')
  const main = page.getByRole('main')
  await main.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Notifications' }).click()
  await expect(main.getByRole('heading', { name: 'Notifications', level: 2 })).toBeVisible()
  await expectFitsPhone(page, 'notifications settings')

  const push = main.getByRole('button', { name: 'Push', exact: true })
  await push.scrollIntoViewIfNeeded()
  await push.click()
  await expect(push).toHaveAttribute('aria-pressed', 'true')
  await expect(main.getByRole('region', { name: 'Push devices' })).toContainText('(this device)')
  await main.getByRole('button', { name: 'Test push', exact: true }).click()
  await expect(toasts(page).filter({ hasText: 'Test sent' })).toBeVisible()
  await expect.poll(() => service.pushes.length).toBe(1)

  const digest = main.getByRole('combobox', { name: 'Digest tier' })
  await digest.scrollIntoViewIfNeeded()
  await digest.tap()
  await page.getByRole('option', { name: 'Toast' }).tap()
  await expect(digest).toHaveText('Toast')
  await expectFitsPhone(page, 'notifications settings with a device')
  await main.getByRole('region', { name: 'Tiers' }).screenshot({ path: test.info().outputPath('tiers.png') })
})

test('an agent that finishes off screen toasts its closing line, and Open shows it', async ({ page, request }) => {
  test.setTimeout(90_000)
  await page.goto('/#context')
  await expect(page.getByRole('main')).toBeVisible()
  const title = unique('Phone finished')
  const id = await startAgent(request, title)
  const toast = toasts(page).filter({ hasText: title })
  await expect(toast).toContainText('done')
  await expect(toast).not.toContainText('Finished')
  await expectFitsPhone(page, 'finished toast')

  await toast.getByRole('button', { name: 'Open' }).click()
  await expect(page).toHaveURL(new RegExp(`#agents/${id}$`))
})
