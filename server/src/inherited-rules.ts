import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PERMISSION_BEHAVIORS, type InheritedRule } from '@seti/shared'
import { CLAUDE_HOME } from './config.js'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The file as the settings page names it, with the home directory as ~. */
function shown(file: string, home: string): string {
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file
}

/** The permission rules a Claude Code settings file holds; a missing or unreadable one has none. */
export function settingsRules(file: string, home = os.homedir()): InheritedRule[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const permissions = isRecord(parsed) ? parsed.permissions : undefined
  if (!isRecord(permissions)) {
    return []
  }
  const source = shown(file, home)
  return PERMISSION_BEHAVIORS.flatMap((behavior) => {
    const list = permissions[behavior]
    return Array.isArray(list)
      ? list.filter((rule): rule is string => typeof rule === 'string').map((rule) => ({ behavior, rule, source }))
      : []
  })
}

/** Rules every agent loads from the user's Claude Code settings, besides Seti's own. */
export const userSettingsRules = (): InheritedRule[] => settingsRules(path.join(CLAUDE_HOME, 'settings.json'))

/** Rules an agent loads from its working directory's project and local Claude Code settings. */
export const projectSettingsRules = (cwd: string): InheritedRule[] =>
  ['settings.json', 'settings.local.json'].flatMap((name) => settingsRules(path.join(cwd, '.claude', name)))
