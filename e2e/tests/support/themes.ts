import type { APIRequestContext, Page } from '@playwright/test'
import { expect } from './fixtures.js'

/** The bundled theme mods, which ship on. */
const THEME_MODS = ['catppuccin', 'claude-theme']

const RECORD = '__setiThemes'

/** Seti's own theme with every theme mod on, so the next test starts as a fresh install does. */
export async function resetThemes(request: APIRequestContext): Promise<void> {
  for (const mod of THEME_MODS) {
    expect((await request.patch(`/api/mods/${mod}`, { data: { enabled: true } })).ok()).toBe(true)
  }
  const theme = { id: 'default', flavour: null, accent: null }
  expect((await request.put('/api/user', { data: { theme } })).ok()).toBe(true)
}

/** A mod's switch on Settings, Mods. */
export const modToggle = (page: Page, name: string) =>
  page.getByRole('region', { name: 'Mods' }).getByRole('button', { name, exact: true })

function record(key: string): void {
  const seen: string[] = []
  Reflect.set(window, key, seen)
  let last = document.querySelector('html')?.getAttribute('data-theme') ?? ''
  new MutationObserver((changes) => {
    for (const { target } of changes) {
      const theme = target instanceof Element ? (target.getAttribute('data-theme') ?? '') : last
      if (theme !== last) {
        seen.push(theme)
        last = theme
      }
    }
  }).observe(document, { attributes: true, attributeFilter: ['data-theme'], subtree: true })
}

/** Records every theme <html> shows from now on, to tell a straight switch from a flash. */
export async function recordThemes(page: Page, fromLoad = false): Promise<void> {
  await (fromLoad ? page.addInitScript(record, RECORD) : page.evaluate(record, RECORD))
}

/** Each theme <html> changed to since recording began, in order. */
export async function recordedThemes(page: Page): Promise<string[]> {
  return page.evaluate((key) => Reflect.get(window, key) as string[], RECORD)
}
