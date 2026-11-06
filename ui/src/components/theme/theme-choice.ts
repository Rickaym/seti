import { DEFAULT_THEME, themeChoice, type ThemeChoice, type UserSettings } from '@seti/shared'
import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { apiPut, errorText } from '@/api'
import { refreshUserName, useUserSettings } from '@/hooks/useUserName'
import { demoResetsAt } from '@/lib/demo'
import { useModsSynced } from '@/mods/synced'
import { themeRegistry } from './registry'

/** Where this browser kept the theme before Seti held it for every device. */
const LEGACY_KEYS = { id: 'seti-ui-theme-id', flavour: 'seti-ui-theme-flavour', accent: 'seti-ui-theme-accent' }

/** The theme this browser showed last, to paint it again before Seti answers. */
const SHOWN_KEY = 'seti-ui-theme-shown'

interface ChoiceState {
  /** Seti's choice: undefined until it answers, null when the user never chose. */
  saved: ThemeChoice | null | undefined
  /** A choice made here that Seti has not confirmed yet. */
  pending: ThemeChoice | null
}

let state: ChoiceState = { saved: undefined, pending: null }
const listeners = new Set<() => void>()

function update(next: Partial<ChoiceState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) {
    listener()
  }
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The user's theme as this page knows it: undefined until Seti answers. */
export function useChosenTheme(): ThemeChoice | null | undefined {
  const current = useSyncExternalStore(subscribe, () => state)
  return current.pending ?? current.saved
}

/** Keeps the choice for every device; the demo keeps it for this visit, as a visitor's own. */
export async function saveTheme(next: ThemeChoice): Promise<void> {
  update({ pending: next })
  if (demoResetsAt() !== null) {
    return
  }
  try {
    const settings = await apiPut<UserSettings>('/user', { theme: next })
    update({ saved: settings.theme, pending: state.pending === next ? null : state.pending })
    refreshUserName()
  } catch (e) {
    update({ pending: state.pending === next ? null : state.pending })
    toast.error('Seti did not keep the theme', { description: errorText(e), duration: Infinity })
  }
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** The choice this browser kept before, as the mod that has the theme now names it. */
export function legacyChoice(
  get: (key: string) => string | null,
  themes: readonly { id: string }[] = themeRegistry.list(),
): ThemeChoice | null {
  const old = get(LEGACY_KEYS.id)
  const id = old === DEFAULT_THEME ? old : themes.find((theme) => theme.id.endsWith(`.${old ?? ''}`))?.id
  const parsed = themeChoice.safeParse({ id, flavour: get(LEGACY_KEYS.flavour), accent: get(LEGACY_KEYS.accent) })
  return parsed.success ? parsed.data : null
}

/** Moves a choice this browser kept to Seti once, when Seti holds none yet, then forgets it. */
function migrateLegacy(saved: ThemeChoice | null): void {
  const legacy = legacyChoice(read)
  try {
    for (const key of Object.values(LEGACY_KEYS)) {
      localStorage.removeItem(key)
    }
  } catch {
    return
  }
  if (saved === null && legacy !== null) {
    void saveTheme(legacy)
  }
}

/** Follows the theme Seti holds once the user is signed in and the mods have started here. */
export function useThemeSync(): void {
  const synced = useModsSynced()
  const settings = useUserSettings()
  const saved = settings === undefined ? undefined : settings.theme
  useEffect(() => {
    if (saved === undefined) {
      return
    }
    update({ saved })
    if (synced) {
      migrateLegacy(saved)
    }
  }, [saved, synced])
}

export function shownTheme(): ThemeChoice | null {
  try {
    const parsed = themeChoice.safeParse(JSON.parse(read(SHOWN_KEY) ?? 'null'))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function rememberShown(shown: ThemeChoice): void {
  try {
    localStorage.setItem(SHOWN_KEY, JSON.stringify(shown))
  } catch {
    // Storage can be blocked; the page then paints the default until Seti answers.
  }
}
