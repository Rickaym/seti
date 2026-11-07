import { defineConfig } from '@playwright/test'

/** Captures the README screenshots from seeded demo data; `pnpm screenshots` runs it. */
export default defineConfig({
  testDir: './screenshots',
  testMatch: /\.shot\.ts$/,
  globalSetup: './tests/support/global-setup.ts',
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  outputDir: './test-results/screenshots',
  use: {
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    serviceWorkers: 'block',
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--force-color-profile=srgb',
        '--disable-lcd-text',
        '--disable-font-subpixel-positioning',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    },
  },
})
