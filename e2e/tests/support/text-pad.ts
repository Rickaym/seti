import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { apiData, expect } from './fixtures.js'

/** Empties the pad on the server, so the next test starts clean. */
export async function clearPad(request: APIRequestContext): Promise<void> {
  const response = await request.put('/api/mods/text-pad/text', { data: { text: '' } })
  expect(response.status(), await response.text()).toBe(200)
}

/** Waits until the server holds the pad's text, which the pad saves a moment after typing. */
export async function expectSaved(request: APIRequestContext, text: string): Promise<void> {
  await expect.poll(async () => (await apiData<{ text: string }>(request, '/mods/text-pad/text')).text).toBe(text)
}

/** The pad's text area. */
export const pad = (page: Page | Locator) => page.getByRole('textbox', { name: 'Pad' })
