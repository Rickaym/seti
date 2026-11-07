import os from 'node:os'
import { defineConfig, devices } from '@playwright/test'

const CI = process.env.CI !== undefined && process.env.CI !== ''

const PHONE_SPEC = /phone\.spec\.ts$/

/** Phone profiles keep their viewport, touch and user agent but run in Chromium like the rest. */
const phone = (device: (typeof devices)[string]) => ({ ...device, browserName: 'chromium' as const })

/** Each worker runs its own Seti and Chromium, so the shared host caps them at four. */
function workers(): number {
  const asked = Number(process.env.SETI_E2E_WORKERS)
  if (Number.isInteger(asked) && asked > 0) {
    return asked
  }
  return Math.max(1, Math.min(4, Math.floor(os.availableParallelism() / 2)))
}

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/support/global-setup.ts',
  fullyParallel: false,
  workers: workers(),
  retries: CI ? 1 : 0,
  forbidOnly: CI,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [[CI ? 'github' : 'list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
    /** Shared by every spec, since a spec with its own launch options needs its own server. */
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  /** Workers take files in this order, so the long phone runs start first instead of trailing. */
  projects: [
    { name: 'iphone-15', testMatch: PHONE_SPEC, use: phone(devices['iPhone 15']) },
    { name: 'pixel-7', testMatch: PHONE_SPEC, use: phone(devices['Pixel 7']) },
    { name: 'desktop', testIgnore: PHONE_SPEC },
  ],
})
