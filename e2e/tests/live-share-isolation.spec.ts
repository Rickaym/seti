import type { Browser, BrowserContext, Page, Response } from '@playwright/test'
import { expect, test } from './support/fixtures.js'
import {
  CDN_PROBE_URL,
  CDN_STYLE_URL,
  expectNothingReached,
  expectOwnerSignedIn,
  LEAVERS,
  liveFrame,
  ownerContext,
  PROBE,
  PROBE_BLOCKED,
  PROBE_LATER,
  responses,
  seedLiveAgent,
  shareLive,
  startElsewhere,
  type Elsewhere,
} from './support/live-shares.js'
import { setSharing } from './support/shares.js'

// WebKit runs too with SETI_E2E_WEBKIT=1; WebRTC, the known limit, is left unasserted.

const byText = (a: string, b: string) => a.localeCompare(b)

test.beforeEach(async ({ request }) => {
  await setSharing(request, true)
})

test.afterEach(async ({ request }) => {
  expect((await request.post('/api/shares/revoke-all', { data: {} })).ok()).toBe(true)
  await setSharing(request, false)
})

interface Visit {
  web: Elsewhere
  owner: BrowserContext
  id: string
  base: string
}

async function visit(browser: Browser, base: string, work: (v: Visit) => Promise<void>) {
  const web = await startElsewhere()
  const owner = await ownerContext(browser, base)
  try {
    const { id } = await seedLiveAgent(web.url, base)
    await work({ web, owner, id, base })
  } finally {
    await owner.close()
    await web.close()
  }
}

function expectShellHeaders(res: Response, url: string): void {
  const headers = res.headers()
  expect(headers['content-security-policy']).toBe(
    `default-src 'none'; style-src 'unsafe-inline'; frame-src ${url}/live; frame-ancestors 'none'; ` +
      "base-uri 'none'; form-action 'none'",
  )
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-dns-prefetch-control']).toBe('off')
  expect(headers['permissions-policy']).toContain('camera=(), clipboard-read=()')
}

function expectFrameHeaders(res: Response): void {
  const headers = res.headers()
  expect(headers['content-security-policy']).toMatch(/^sandbox allow-scripts; default-src 'none'; script-src /)
  expect(headers['content-security-policy']).toContain("connect-src 'none'; frame-src 'none'")
  expect(headers['x-frame-options']).toBe('SAMEORIGIN')
  expect(headers['content-type']).toBe('text/html; charset=utf-8')
}

function expectCommonHeaders(res: Response): void {
  const headers = res.headers()
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['x-robots-tag']).toBe('noindex, nofollow')
  expect(headers['cache-control']).toBe('no-store')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['set-cookie']).toBeUndefined()
}

/** The probe's report: fixed lines first, then the asynchronous ones in whatever order they ended. */
async function expectProbeBlocked(page: Page): Promise<void> {
  const frame = await liveFrame(page)
  await expect(frame.locator('#done')).toHaveText('done')
  const lines = await frame.locator('#results li').allTextContents()
  expect(lines.slice(0, PROBE_BLOCKED.length)).toEqual(PROBE_BLOCKED)
  expect(lines.slice(PROBE_BLOCKED.length).sort(byText)).toEqual([...PROBE_LATER].sort(byText))
}

/** Nothing answered from outside Seti, and nothing from Seti's API. */
function expectOnlySeti(seen: string[], base: string): void {
  expect(seen.filter((url) => new URL(url).origin !== base)).toEqual([])
  expect(seen.filter((url) => new URL(url).pathname.startsWith('/api/'))).toEqual([])
}

test('a live page runs in an opaque origin, reaches neither Seti nor the web, and leaves the owner signed in', async ({
  browser,
  baseURL,
}) => {
  await visit(browser, baseURL ?? '', async ({ web, owner, id, base }) => {
    const url = await shareLive(owner, id, 'probe.html')
    const page = await owner.newPage()
    const seen = responses(owner)
    const shell = page.waitForResponse((res) => res.url() === url)
    const frame = page.waitForResponse((res) => res.url() === `${url}/live`)
    await page.goto(url)
    for (const res of [await shell, await frame]) {
      expectCommonHeaders(res)
    }
    expectShellHeaders(await shell, url)
    expectFrameHeaders(await frame)
    await expect(page.getByRole('heading', { name: 'probe.html' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Static view' })).toHaveAttribute(
      'href',
      `${new URL(url).pathname}/static`,
    )
    await expect(page.locator('script')).toHaveCount(0)
    await expectProbeBlocked(page)
    await page.reload()
    await expectProbeBlocked(page)
    await expectNothingReached(web)
    expect(page.url()).toBe(url)
    expect(owner.pages()).toHaveLength(1)
    expectOnlySeti(seen, base)
    await expectOwnerSignedIn(owner)
  })
})

test('links, forms, downloads and popups in a live page go nowhere', async ({ browser, baseURL }) => {
  await visit(browser, baseURL ?? '', async ({ web, owner, id, base }) => {
    const url = await shareLive(owner, id, 'probe.html')
    const page = await owner.newPage()
    const seen = responses(owner)
    let downloads = 0
    page.on('download', () => {
      downloads += 1
    })
    for (const target of ['#self', '#to-top', '#blank', '#save', '#send', '#send-top']) {
      await page.goto(url)
      const frame = await liveFrame(page)
      await frame.locator(target).click()
      await expectNothingReached(web)
      expect(page.url(), target).toBe(url)
    }
    expect(downloads).toBe(0)
    expect(owner.pages()).toHaveLength(1)
    expectOnlySeti(seen, base)
    await expectOwnerSignedIn(owner)
  })
})

test('a live page cannot navigate its frame to the web, to Seti or to data', async ({ browser, baseURL }) => {
  await visit(browser, baseURL ?? '', async ({ web, owner, id, base }) => {
    const page = await owner.newPage()
    const seen = responses(owner)
    for (const file of LEAVERS) {
      const url = await shareLive(owner, id, file)
      await page.goto(url)
      await expectNothingReached(web)
      expect(page.url(), file).toBe(url)
      const framed = page.frames().filter((frame) => frame.url().startsWith(base))
      expect(
        framed.map((frame) => frame.url()).filter((at) => at !== url && at !== `${url}/live`),
        file,
      ).toEqual([])
    }
    expectOnlySeti(seen, base)
    await expectOwnerSignedIn(owner)
  })
})

test('the frame never opens as a tab, and neither part opens inside another site', async ({ browser, baseURL }) => {
  await visit(browser, baseURL ?? '', async ({ web, owner, id }) => {
    const url = await shareLive(owner, id, 'probe.html')
    const page = await owner.newPage()
    expect((await page.goto(`${url}/live`))?.status()).toBe(404)
    for (const [src, heading] of [
      [url, 'probe.html'],
      [`${url}/live`, 'Live probe'],
    ] as const) {
      await page.goto(`${web.url}/frame?src=${encodeURIComponent(src)}`)
      await expectNothingReached(web)
      for (const frame of page.frames().slice(1)) {
        expect(await frame.getByRole('heading', { name: heading }).count(), src).toBe(0)
      }
    }
  })
})

test('a script from an allowed CDN path gains nothing an inline one lacks; other paths and images never load', async ({
  browser,
  baseURL,
}) => {
  await visit(browser, baseURL ?? '', async ({ web, owner, id, base }) => {
    const asked: string[] = []
    await owner.route(/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\//, async (route) => {
      const url = route.request().url()
      asked.push(url)
      if (url === CDN_PROBE_URL) {
        await route.fulfill({ contentType: 'text/javascript', body: PROBE(web.url, base) })
      } else if (url === CDN_STYLE_URL) {
        await route.fulfill({ contentType: 'text/css', body: 'h1 { color: rgb(1, 2, 3) }' })
      } else {
        await route.fulfill({ status: 404, body: '' })
      }
    })
    const url = await shareLive(owner, id, 'cdn.html')
    const page = await owner.newPage()
    await page.goto(url)
    await expectProbeBlocked(page)
    const frame = await liveFrame(page)
    await expect(frame.getByRole('heading', { name: 'CDN probe' })).toHaveCSS('color', 'rgb(1, 2, 3)')
    await expectNothingReached(web)
    expect([...new Set(asked)].sort(byText)).toEqual([CDN_PROBE_URL, CDN_STYLE_URL].sort(byText))
    await expectOwnerSignedIn(owner)
  })
})
