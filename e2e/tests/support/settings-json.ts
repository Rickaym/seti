import type { APIRequestContext, Page } from '@playwright/test'
import { applyPatch, JSON_WRITABLE, valueAt, type SettingsDoc } from '@seti/shared'
import { apiData } from './fixtures.js'

/** The editor's text for the settings the API serves now, with `change` merged in. */
export async function editedText(request: APIRequestContext, change: Record<string, unknown>): Promise<string> {
  const doc = await apiData<SettingsDoc>(request, '/settings-doc')
  const groups: Record<string, Record<string, Record<string, unknown>>> = {}
  for (const [path, keys] of Object.entries(JSON_WRITABLE)) {
    const [group = '', page = ''] = path.split('.')
    const section = valueAt(doc, [group, page]) as Record<string, unknown>
    groups[group] = { ...groups[group], [page]: Object.fromEntries(keys.map((key) => [key, section[key]])) }
  }
  const mods = Object.entries(doc.mods as Record<string, { settings: Record<string, unknown> }>).filter(
    ([, mod]) => Object.keys(mod.settings).length > 0,
  )
  const editable = { ...groups, mods: Object.fromEntries(mods.map(([id, mod]) => [id, { settings: mod.settings }])) }
  return JSON.stringify(
    applyPatch(editable, change, () => false),
    null,
    2,
  )
}

/** Replaces the whole text of the settings JSON editor. */
export async function typeSettings(page: Page, text: string, tap = false): Promise<void> {
  const editor = page.getByRole('textbox', { name: 'Settings JSON' })
  await (tap ? editor.tap() : editor.click())
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText(text)
}
