import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface Painted {
  inside: boolean
  slot: string | null
}

/** The topmost painted element at a point; pointer events go on, since modals turn them off. */
async function paintedAt(target: Locator, x: number, y: number): Promise<Painted> {
  return target.evaluate(
    (node, [px, py]) => {
      const style = document.createElement('style')
      style.textContent = '* { pointer-events: auto !important; }'
      document.head.append(style)
      const hit = document.elementFromPoint(px, py)
      style.remove()
      return {
        inside: hit !== null && node.contains(hit),
        slot: hit?.closest('[data-slot]')?.getAttribute('data-slot') ?? null,
      }
    },
    [x, y] as const,
  )
}

const contains = (box: Box, x: number, y: number) =>
  x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height

async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  expect(box, 'the layer has a box on screen').not.toBeNull()
  return box ?? { x: 0, y: 0, width: 0, height: 0 }
}

/** A point inside `under` that `over` does not cover, tried at each corner in turn. */
async function uncoveredPoint(under: Locator, over: Locator): Promise<[number, number]> {
  const [u, o] = [await boxOf(under), await boxOf(over)]
  const inset = 6
  const corners: [number, number][] = [
    [u.x + inset, u.y + inset],
    [u.x + u.width - inset, u.y + inset],
    [u.x + inset, u.y + u.height - inset],
    [u.x + u.width - inset, u.y + u.height - inset],
  ]
  const free = corners.find(([x, y]) => !contains(o, x, y))
  expect(free, 'part of the lower layer shows beside the nested dialog').toBeDefined()
  return free ?? corners[0]
}

/** The nested dialog's overlay paints over the part of `parent` that the dialog leaves visible. */
export async function expectCovered(parent: Locator, nested: Locator) {
  const [x, y] = await uncoveredPoint(parent, nested)
  const painted = await paintedAt(parent, x, y)
  expect(painted.inside, 'the lower layer paints above the nested overlay').toBe(false)
  expect(painted.slot).toBe('dialog-overlay')
}

/** Nothing paints over the middle of `layer`. */
export async function expectOnTop(layer: Locator) {
  const box = await boxOf(layer)
  const painted = await paintedAt(layer, box.x + box.width / 2, box.y + box.height / 2)
  expect(painted.inside, 'another layer paints over this one').toBe(true)
}

/** Makes the next access change fail, so a failure toast shows over the open dialogs. */
export async function failAccessChange(page: Page) {
  await page.route('**/api/tasks/*/access', async (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { error: { detail: 'Access store unavailable' } } })
      : route.fallback(),
  )
}

/** Screenshots the page in the light and the dark scheme, then returns it to light. */
export async function shootSchemes(page: Page, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: test.info().outputPath(`${name}-${scheme}.png`), animations: 'disabled' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}

/** A dialog found by name while a dialog above hides it from the role tree. */
export const coveredDialog = (page: Page, name: string | RegExp): Locator =>
  page.getByRole('dialog', { name, includeHidden: true })
