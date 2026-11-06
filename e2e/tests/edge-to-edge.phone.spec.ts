import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { Locator, Page } from '@playwright/test'
import { openSeedDb } from './support/db.js'
import { paths } from './support/env.js'
import { expect, test } from './support/fixtures.js'
import { safeAreas, type Insets } from './support/ios.js'

/** The status bar and the gesture handle on a Pixel 7, in CSS pixels. */
const GESTURES: Insets = { top: 32, bottom: 24, left: 0, right: 0 }
/** Three-button navigation takes a taller bar at the bottom. */
const BUTTONS: Insets = { top: 32, bottom: 48, left: 0, right: 0 }
/** Turned sideways, the camera cutout sits on one long edge. */
const SIDEWAYS: Insets = { top: 24, bottom: 24, left: 32, right: 0 }

const THEMES_XML = new URL('../../android/app/src/main/res/values/themes.xml', import.meta.url)

async function box(locator: Locator) {
  const found = await locator.boundingBox()
  expect(found, 'bounding box').not.toBeNull()
  return found ?? { x: 0, y: 0, width: 0, height: 0 }
}

const header = (page: Page) => page.getByRole('banner')
const statusBar = (page: Page) => page.getByRole('contentinfo')

/** Runs in the page: each control whose visible part reaches under a system bar or cutout. */
function underSystemBars(insets: Insets): string[] {
  const width = document.documentElement.clientWidth
  const height = window.innerHeight
  /** The part of `el` its clipping ancestors let through. */
  const visible = (el: Element) => {
    const rect = el.getBoundingClientRect()
    const edges = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    for (let node = el.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const clip = node.getBoundingClientRect()
        edges.left = Math.max(edges.left, clip.left)
        edges.top = Math.max(edges.top, clip.top)
        edges.right = Math.min(edges.right, clip.right)
        edges.bottom = Math.min(edges.bottom, clip.bottom)
      }
      if (style.position === 'fixed') {
        break
      }
    }
    return edges
  }
  const controls = 'a[href], button, input, textarea, select, [role="button"], [role="tab"], [role="link"]'
  const problems: string[] = []
  for (const el of Array.from(document.querySelectorAll<HTMLElement>(controls))) {
    if (el.closest('[aria-hidden="true"]') !== null || !el.checkVisibility({ visibilityProperty: true })) {
      continue
    }
    const { left, top, right, bottom } = visible(el)
    const shown = right - left >= 1 && bottom - top >= 1
    const clear =
      top >= insets.top - 0.5 &&
      bottom <= height - insets.bottom + 0.5 &&
      left >= insets.left - 0.5 &&
      right <= width - insets.right + 0.5
    if (shown && !clear) {
      const name = (el.getAttribute('aria-label') ?? el.textContent).trim().slice(0, 40)
      problems.push(
        `<${el.tagName.toLowerCase()}> "${name}" at ${[left, top, right, bottom].map(Math.round).join(',')}`,
      )
    }
  }
  return problems
}

/** The header and status bar paint behind the system bars and pad their content clear of them. */
async function expectEdgeToEdge(page: Page, insets: Insets): Promise<void> {
  const height = page.viewportSize()?.height ?? 0
  const top = await box(header(page))
  expect(top.y).toBe(0)
  expect(await header(page).evaluate((el) => getComputedStyle(el).paddingTop)).toBe(`${String(insets.top)}px`)
  const bottom = await box(statusBar(page))
  expect(Math.round(bottom.y + bottom.height)).toBe(height)
  expect(await statusBar(page).evaluate((el) => getComputedStyle(el).paddingBottom)).toBe(`${String(insets.bottom)}px`)
  expect(await page.evaluate(underSystemBars, insets)).toEqual([])
}

async function seedAgent(): Promise<string> {
  const db = openSeedDb()
  const id = randomUUID()
  await db.idleTask(id, `Edge to edge ${id.slice(0, 8)}`, paths.checkout, new Date().toISOString())
  await db.close()
  return id
}

for (const [mode, insets] of [
  ['gesture', GESTURES],
  ['three-button', BUTTONS],
] as const) {
  test(`with ${mode} navigation the app fills the screen and keeps controls off the system bars`, async ({ page }) => {
    await safeAreas(page, insets)
    await page.goto('/')
    await expect(header(page)).toBeVisible()
    await expectEdgeToEdge(page, insets)

    const id = await seedAgent()
    await page.goto(`/#agents/${id}`)
    const reply = page.getByLabel('Reply', { exact: true })
    await expect(reply).toBeVisible()
    await expect(header(page), 'the agent view keeps the app header').toBeVisible()
    const appBar = await box(header(page))
    expect(appBar.y).toBe(0)
    expect((await box(page.getByTestId('agent-header'))).y).toBe(appBar.y + appBar.height)
    expect(await page.evaluate(underSystemBars, insets)).toEqual([])
    const height = page.viewportSize()?.height ?? 0
    const send = await box(page.getByRole('button', { name: 'Send' }))
    expect(send.y + send.height).toBeLessThanOrEqual(height - insets.bottom)
  })
}

test('turned sideways, the header clears the status bar and the cutout', async ({ page }) => {
  const size = page.viewportSize() ?? { width: 412, height: 839 }
  await page.setViewportSize({ width: size.height, height: size.width })
  await safeAreas(page, SIDEWAYS)
  await page.goto('/')
  await expect(header(page)).toBeVisible()
  await expectEdgeToEdge(page, SIDEWAYS)
})

/** A painted background as #rrggbb, whatever colour space the theme writes it in. */
const background = async (locator: Locator) =>
  locator.evaluate((el) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (ctx === null) {
      return ''
    }
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data
    return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
  })

function androidColour(name: string): string {
  const xml = fs.readFileSync(THEMES_XML, 'utf8')
  const found = new RegExp(`<color name="${name}">#FF([0-9A-Fa-f]{6})</color>`).exec(xml)
  expect(found, `${name} in themes.xml`).not.toBeNull()
  return `#${(found?.[1] ?? '').toLowerCase()}`
}

for (const scheme of ['light', 'dark'] as const) {
  test(`without edge to edge, the ${scheme} system bars match the header and status bar`, async ({ page }) => {
    const suffix = scheme === 'dark' ? '_dark' : ''
    await page.emulateMedia({ colorScheme: scheme })
    await page.goto('/')
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${scheme}\\b`))
    const top = await background(header(page))
    for (const meta of await page.locator('meta[name="theme-color"]').all()) {
      await expect(meta).toHaveAttribute('content', top)
    }
    expect(androidColour(`seti_status_bar${suffix}`)).toBe(top)
    expect(androidColour(`seti_navigation_bar${suffix}`)).toBe(await background(statusBar(page)))
  })
}
