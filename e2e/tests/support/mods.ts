import { type APIRequestContext, type Page, expect } from '@playwright/test'

/** Turns the sample mod off and puts its settings back, so the next test starts clean. */
export async function resetSampleMod(request: APIRequestContext): Promise<void> {
  await request.patch('/api/mods/sample', {
    data: { enabled: false, settings: { greeting: 'Hello', loud: false }, notifications: { hello: true } },
  })
}

/** Turns a mod on or off through the API, as Settings, Mods does. */
export async function setModEnabled(request: APIRequestContext, id: string, enabled: boolean): Promise<void> {
  const response = await request.patch(`/api/mods/${id}`, { data: { enabled } })
  expect(response.status(), await response.text()).toBe(200)
}

/** A mod's switch on Settings, Mods, by the mod's name. */
export const modToggle = (page: Page, name: string) =>
  page.getByRole('region', { name: 'Mods' }).getByRole('button', { name, exact: true })

/** The sample mod's switch on Settings, Mods. */
export const sampleToggle = (page: Page) => modToggle(page, 'Sample')

/** A format switch of the Previews mod: PDF, Spreadsheets and CSV, or Mermaid. */
type PreviewFormat = 'pdf' | 'sheets' | 'mermaid'

/** Turns one format of the Previews mod on or off through the API, as its settings page does. */
export async function setPreviewFormat(request: APIRequestContext, format: PreviewFormat, on: boolean): Promise<void> {
  const response = await request.patch('/api/mods/previews', { data: { settings: { [format]: on } } })
  expect(response.status(), await response.text()).toBe(200)
}

/** Puts the Previews mod back on with every format on, so the next test starts clean. */
export async function resetPreviews(request: APIRequestContext): Promise<void> {
  const response = await request.patch('/api/mods/previews', {
    data: { enabled: true, settings: { pdf: true, sheets: true, mermaid: true } },
  })
  expect(response.status(), await response.text()).toBe(200)
}
