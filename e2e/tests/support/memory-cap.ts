import type { Locator, Page } from '@playwright/test'
import { defaultMemoryCap, type MemoryCap, type MemoryCapSettings } from '@seti/shared'
import { expect } from './fixtures.js'

const GIB_MB = 1024

/** Hosts on both sides of the default's 16 GB ceiling: 30% of 64 GB clamps, 30% of 16 GB lifts. */
export const HOSTS = [
  { name: 'a 64 GB host', defaults: defaultMemoryCap(64 * GIB_MB), softGb: '10.5' },
  { name: 'a 16 GB host', defaults: defaultMemoryCap(16 * GIB_MB), softGb: '4' },
] as const

/**
 * Answers the card's GET as Seti on that host would once the user saved its default, so the
 * card renders the host the suite does not run on; saves still reach the real server.
 */
export async function onHost(page: Page, defaults: MemoryCap): Promise<void> {
  const settings: MemoryCapSettings = {
    cap: defaults,
    defaults,
    enforced: true,
    updated_at: '2026-11-18T13:09:08.126Z',
  }
  await page.route('**/api/resources/memory', async (route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { data: settings, meta: {} } }) : route.fallback(),
  )
}

export const memoryCard = (page: Page) => page.getByRole('main').getByRole('region', { name: 'Memory cap' })

/** A size field whose value the step accepts and that shows all of it. */
export async function expectWholeValue(field: Locator, value: string): Promise<void> {
  await expect(field).toHaveValue(value)
  const fit = await field.evaluate((el) => {
    const input = el as HTMLInputElement
    return { valid: input.validity.valid, clipped: input.scrollWidth > input.clientWidth }
  })
  expect(fit, `${value} in its field`).toEqual({ valid: true, clipped: false })
}

/** The explanation under the fields wraps at word ends, inside the box the fields take. */
export async function expectExplanationWraps(fields: Locator): Promise<void> {
  const text = fields.getByText(/^Over the RAM cap/)
  const box = await text.evaluate((el) => ({
    breaks: getComputedStyle(el).wordBreak,
    overflows: el.scrollWidth > (el.parentElement?.clientWidth ?? 0),
  }))
  expect(box).toEqual({ breaks: 'normal', overflows: false })
}
