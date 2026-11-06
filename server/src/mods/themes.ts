import { DEFAULT_THEME, modScoped, type ThemeChoice } from '@seti/shared'
import { audit } from '../audit.js'
import { fromAgent, fromEa, refuseAtSelf, refuseMod } from '../ea-guard.js'
import { HttpError } from '../http.js'
import { userSettings } from '../store/user.js'
import { currentSettings } from '../user-settings.js'
import { modHost } from './bundled.js'

/** A theme Seti has: its own, or one a mod declares, with whether that mod runs now. */
export interface ThemeEntry {
  id: string
  title: string
  /** The mod's name; null for Seti's own. */
  mod: string | null
  on: boolean
  flavours: string[]
  accents: string[]
}

const DEFAULT_ENTRY: ThemeEntry = {
  id: DEFAULT_THEME,
  title: 'Default',
  mod: null,
  on: true,
  flavours: [],
  accents: [],
}

/** Seti's own theme and every theme a mod it has declares, on or off. */
export function themeEntries(): ThemeEntry[] {
  const declared = modHost.list().flatMap((mod) => {
    const manifest = mod.manifest
    return manifest === null
      ? []
      : manifest.contributes.themes.map((theme) => ({
          id: modScoped(manifest.id, theme.id),
          title: theme.title,
          mod: manifest.name,
          on: mod.disposers !== null,
          flavours: theme.flavours?.options.map((option) => option.id) ?? [],
          accents: theme.accents?.options.map((option) => option.id) ?? [],
        }))
  })
  return [DEFAULT_ENTRY, ...declared]
}

function optionProblem(theme: ThemeEntry, what: 'flavour' | 'accent', value: string | null): string | null {
  const offered = what === 'flavour' ? theme.flavours : theme.accents
  if (value === null || offered.length === 0 || offered.includes(value)) {
    return null
  }
  return `The ${theme.title} theme has no ${what} ${value}; it offers ${offered.join(', ')}`
}

/** The EA and agents pick only a theme the user can see now, with options it offers. */
function delegateProblem(theme: ThemeEntry, choice: ThemeChoice): string | null {
  if (!theme.on) {
    return `The ${theme.title} theme comes from the ${theme.mod ?? 'its'} mod, which is off; turn it on first`
  }
  return optionProblem(theme, 'flavour', choice.flavour) ?? optionProblem(theme, 'accent', choice.accent)
}

/** Keeps the theme for every device; the user may keep one whose mod is off, shown once it is on. */
export async function saveTheme(choice: ThemeChoice): Promise<void> {
  refuseMod('change the theme')
  const theme = themeEntries().find((entry) => entry.id === choice.id)
  if (theme === undefined) {
    throw new HttpError(400, `Seti has no theme ${choice.id}`)
  }
  if (fromEa() || fromAgent()) {
    refuseAtSelf('change the theme')
    const problem = delegateProblem(theme, choice)
    if (problem !== null) {
      throw new HttpError(409, problem)
    }
  }
  await currentSettings()
  await userSettings.setTheme(choice)
  await audit.record({
    actor: 'user',
    kind: 'system.theme_changed',
    subject_type: 'system',
    summary: `Changed the theme to ${theme.title}`,
    detail: { theme: choice.id, flavour: choice.flavour, accent: choice.accent },
  })
}
