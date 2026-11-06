import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium, type Page } from '@playwright/test'
import { expect, loadAssetsThroughNode, test, toasts } from './support/fixtures.js'

test.use({ serviceWorkers: 'allow' })

interface ManifestIcon {
  src: string
  sizes: string
  type: string
  purpose: string
}

interface Manifest {
  name: string
  short_name: string
  start_url: string
  scope: string
  display: string
  display_override: string[]
  theme_color: string
  background_color: string
  icons: ManifestIcon[]
  shortcuts: { name: string; url: string; icons: Omit<ManifestIcon, 'purpose'>[] }[]
}

const HEX = /^#[0-9a-f]{6}$/

/** Width and height from the IHDR chunk, which always follows the 8-byte PNG signature. */
const pngSize = (png: Buffer) => `${String(png.readUInt32BE(16))}x${String(png.readUInt32BE(20))}`

async function controlledPage(page: Page): Promise<string> {
  await page.goto('/')
  await expect(page.getByRole('banner')).toBeVisible()
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null))
    .not.toBe(null)
  return page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '')
}

test('the page links a valid manifest with fetchable icons', async ({ page, request }) => {
  await page.goto('/')
  const link = page.locator('link[rel="manifest"]')
  await expect(link).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(link).toHaveAttribute('crossorigin', 'use-credentials')
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Seti')
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'default')
  const touchIcon = page.locator('link[rel="apple-touch-icon"]')
  await expect(touchIcon).toHaveAttribute('href', '/apple-touch-icon.png')
  await expect(touchIcon).toHaveAttribute('sizes', '180x180')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
  await expect(page.locator('meta[name="format-detection"]')).toHaveAttribute('content', 'telephone=no')
  const touchPng = await request.get('/apple-touch-icon.png')
  expect(pngSize(await touchPng.body())).toBe('180x180')

  const response = await request.get('/manifest.webmanifest')
  expect(response.ok()).toBe(true)
  expect(response.headers()['content-type']).toBe('application/manifest+json')
  const manifest = (await response.json()) as Manifest
  expect(manifest).toMatchObject({
    name: 'Seti',
    short_name: 'Seti',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay'],
  })
  expect(manifest.theme_color).toMatch(HEX)
  expect(manifest.background_color).toMatch(HEX)
  const icons = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose}`)
  expect(icons.toSorted((a, b) => a.localeCompare(b))).toEqual([
    '192x192 any',
    '192x192 maskable',
    '512x512 any',
    '512x512 maskable',
  ])
  expect(manifest.shortcuts.map(({ name, url }) => ({ name, url }))).toEqual([
    { name: 'New agent', url: '/#agents/new' },
    { name: 'Needs you', url: '/?view=needs-you' },
  ])
  for (const icon of [...manifest.icons, ...manifest.shortcuts.flatMap((shortcut) => shortcut.icons)]) {
    const png = await request.get(icon.src)
    expect(png.ok(), icon.src).toBe(true)
    expect(png.headers()['content-type'], icon.src).toBe(icon.type)
    expect(pngSize(await png.body()), icon.src).toBe(icon.sizes)
  }
})

test('the theme colour follows the chosen scheme', async ({ page }) => {
  await page.goto('/')
  const themeColours = page.locator('meta[name="theme-color"]')
  await expect(themeColours).toHaveCount(2)
  await expect(themeColours.first()).toHaveAttribute('content', '#ffffff')
  await page.evaluate(() => {
    localStorage.setItem('seti-ui-theme', 'dark')
  })
  await page.reload()
  await expect(page.locator('html')).toHaveClass(/\bdark\b/)
  for (const meta of await themeColours.all()) {
    await expect(meta).toHaveAttribute('content', '#131921')
  }
})

/** The headless shell skips the installability check and incognito contexts fail it by design. */
test('Chromium parses the manifest and finds the app installable', async ({ setiServer }) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-pwa-'))
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', baseURL: setiServer.baseURL })
  try {
    await loadAssetsThroughNode(context, setiServer.baseURL)
    const page = await context.newPage()
    await controlledPage(page)
    const cdp = await context.newCDPSession(page)
    const manifest = await cdp.send('Page.getAppManifest')
    expect(manifest.url).toMatch(/\/manifest\.webmanifest$/)
    expect(manifest.errors).toEqual([])
    const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
    expect(installabilityErrors).toEqual([])
  } finally {
    await context.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})

test('the service worker controls the page and never answers for the API', async ({ page }) => {
  expect(await controlledPage(page)).toMatch(/\/sw\.js$/)
  const api: boolean[] = []
  const assets: boolean[] = []
  page.on('response', (response) => {
    const { pathname } = new URL(response.url())
    if (pathname.startsWith('/api/')) {
      api.push(response.fromServiceWorker())
    } else if (pathname.startsWith('/assets/')) {
      assets.push(response.fromServiceWorker())
    }
  })
  await page.reload()
  await expect(page.getByRole('banner')).toBeVisible()
  await expect.poll(() => api.length).toBeGreaterThan(0)
  await expect.poll(() => assets.length).toBeGreaterThan(0)
  expect(
    api.every((fromWorker) => !fromWorker),
    'API responses served by the worker',
  ).toBe(true)
  expect(assets.every(Boolean), 'assets served by the worker').toBe(true)

  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      urls.push(...(await cache.keys()).map((request) => new URL(request.url).pathname))
    }
    return urls
  })
  expect(cached).toContain('/index.html')
  expect(cached).toContain('/manifest.webmanifest')
  expect(cached.filter((pathname) => pathname.startsWith('/api'))).toEqual([])
})

test('the cached shell opens while offline', async ({ page, context }) => {
  await controlledPage(page)
  await page.goto('about:blank')
  const offline = await context.newPage()
  await context.setOffline(true)
  try {
    await offline.goto('/')
    await expect(offline).toHaveTitle('Seti')
    await expect(offline.getByRole('banner')).toBeVisible()
  } finally {
    await context.setOffline(false)
    await offline.close()
  }
})

test('share links pass the worker by, so they never get the cached shell', async ({ page, context }) => {
  await controlledPage(page)
  const share = await context.newPage()
  const link = `/share/${'A'.repeat(43)}`
  try {
    const online = await share.goto(link)
    expect(online?.status()).toBe(404)
    expect(online?.fromServiceWorker()).toBe(false)
    await expect(share.locator('body')).toHaveText('Not found')
    await context.setOffline(true)
    await expect(share.goto(link)).rejects.toThrow(/ERR_INTERNET_DISCONNECTED/)
  } finally {
    await context.setOffline(false)
    await share.close()
  }
})

test('a waiting worker offers a reload that switches to it', async ({ page }) => {
  await controlledPage(page)
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js?next')
  })
  const toast = toasts(page).filter({ hasText: 'Seti updated' })
  await expect(toast).toBeVisible()
  await Promise.all([page.waitForEvent('load'), toast.getByRole('button', { name: 'Reload' }).click()])
  await expect
    .poll(async () => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''))
    .toMatch(/\/sw\.js\?next$/)
})
