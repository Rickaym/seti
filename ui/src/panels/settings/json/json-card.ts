import { SETTINGS_SECTIONS } from '@seti/shared'
import { createContext } from 'react'
import { modOfSettingsKey } from '../mods/mod-settings-key'

/** The settings page on screen, so its header can open the same settings in the JSON page. */
export const SettingsPageContext = createContext<string | null>(null)

const SECTION_OF_PAGE = new Map(Object.entries(SETTINGS_SECTIONS).map(([path, section]) => [section.page, path]))

/** The JSON page's card for a settings page: its section, or a mod's own; null when it has none. */
export function jsonCardOf(page: string | null): string | null {
  if (page === null || page === 'json') {
    return null
  }
  const path = SECTION_OF_PAGE.get(page)
  if (path !== undefined) {
    return `json-${path}`
  }
  const mod = modOfSettingsKey(page)
  return mod === page ? null : `json-mods.${mod}`
}
