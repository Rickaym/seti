import type { z } from 'zod'
import { APP_AGENT_SECTIONS } from './settings-doc-agents.js'
import { SECURITY_SECTIONS } from './settings-doc-security.js'

/** Every section of the settings document by its path, in the order Settings lists them. */
export const SETTINGS_SECTIONS = { ...APP_AGENT_SECTIONS, ...SECURITY_SECTIONS }

export type SettingsSectionPath = keyof typeof SETTINGS_SECTIONS

/** The values of one section, as the server reads them from its stores. */
export type SettingsSectionValue<P extends SettingsSectionPath> = z.output<(typeof SETTINGS_SECTIONS)[P]['schema']>
