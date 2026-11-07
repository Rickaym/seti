import fs from 'node:fs'
import path from 'node:path'
import { devices, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { NOW } from './clock.js'
import type { Encoder, ImageType } from './encoder.js'
import { mockLiveServices } from './mocks.js'
import { USER_HEADERS } from '../tests/support/env.js'
import { loadAssetsThroughNode } from '../tests/support/fixtures.js'

const OUT_DIR = process.env.SETI_SHOTS_DIR ?? path.join(import.meta.dirname, '../../docs/screenshots')

export type Theme = 'light' | 'dark'
export type Device = 'desktop' | 'phone' | 'android'

const { defaultBrowserType: _webkit, ...IPHONE } = devices['iPhone 15']
const { defaultBrowserType: _chromium, ...PIXEL } = devices['Pixel 7']

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  phone: { ...IPHONE, deviceScaleFactor: 2 },
  /** 1080x1920, the 9:16 frame Google Play features. */
  android: {
    ...PIXEL,
    viewport: { width: 432, height: 768 },
    screen: { width: 432, height: 768 },
    deviceScaleFactor: 2.5,
  },
}

/** Failure toasts only raise failures after this mark, as in the e2e fixtures. */
function quietBrowser(): void {
  try {
    localStorage.setItem('seti.failures.since', '9999-12-31T00:00:00.000Z')
  } catch {
    // Storage can be blocked; the page then shows its own defaults.
  }
}

/** A signed-in browser at the device's size and theme, its clock stopped at NOW. */
export interface Viewer {
  device: Device
  theme: Theme
  /** False for a stranger with a share link: no token and no mocked services. */
  signedIn?: boolean
}

export async function openContext(
  browser: Browser,
  baseURL: string,
  { device, theme, signedIn = true }: Viewer,
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...VIEWPORTS[device],
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    serviceWorkers: 'block',
    baseURL,
    ...(signedIn ? { extraHTTPHeaders: USER_HEADERS, permissions: ['microphone'] } : {}),
  })
  await context.clock.setFixedTime(NOW)
  await context.addInitScript(quietBrowser)
  if (signedIn) {
    await loadAssetsThroughNode(context, baseURL)
  }
  return context
}

export async function newPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage()
  await mockLiveServices(page)
  return page
}

/** The floating steps through the user's own messages cover transcript text in a still. */
const HIDDEN = '[data-testid="own-message-nav"] { visibility: hidden; }'

/** Polled panels refresh within a second of the page showing its data. */
const SETTLE_MS = 1200

/** A frame's format, and for a README phone shot the theme of the phone drawn round it. */
interface Output {
  type: ImageType
  phone?: Theme
}

/** Lets the page settle, then writes it to `file` unless only antialiasing changed. */
export async function shootTo(page: Page, encoder: Encoder, file: string, { type, phone }: Output): Promise<void> {
  await page.evaluate(async () => document.fonts.ready)
  await page.mouse.move(0, 0)
  await page.waitForTimeout(SETTLE_MS)
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'device', style: HIDDEN })
  const next = phone === undefined ? await encoder.encode(png, type) : await encoder.phone(png, phone)
  if (fs.existsSync(file) && !(await encoder.differs(fs.readFileSync(file), next, type))) {
    return
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, next)
}

/** Writes the README frame `<name>-<theme>.webp`, a phone shot inside a drawn phone. */
export async function shoot(page: Page, encoder: Encoder, name: string, { device, theme }: Viewer): Promise<void> {
  const output: Output = device === 'phone' ? { type: 'webp', phone: theme } : { type: 'webp' }
  await shootTo(page, encoder, path.join(OUT_DIR, `${name}-${theme}.webp`), output)
}
