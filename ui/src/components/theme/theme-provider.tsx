import { DEFAULT_THEME, type ThemeChoice } from '@seti/shared'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useCommands } from '@/components/palette/useCommands'
import { usePrefersDark } from '@/hooks/useMedia'
import { refitAgentColors } from '@/lib/agent-color-sheet'
import { useModsSynced } from '@/mods/synced'
import { applyTheme } from './apply'
import { resolveTheme, schemeFor, themeRegistry, useThemes, type Scheme } from './registry'
import { rememberShown, saveTheme, shownTheme, useChosenTheme } from './theme-choice'
import { syncThemeColor } from './theme-color'
import { isMode, ThemeContext, type Mode } from './theme-context'

const MODE_KEY = 'seti-ui-theme'

function storedMode(): Mode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    return isMode(value) ? value : 'system'
  } catch {
    return 'system'
  }
}

function rememberMode(mode: Mode): void {
  try {
    localStorage.setItem(MODE_KEY, mode)
  } catch {
    // Storage can be blocked; the mode then lasts for this visit only.
  }
}

const NO_CHOICE: ThemeChoice = { id: DEFAULT_THEME, flavour: null, accent: null }

/**
 * The theme Seti holds for every device and this browser's light or dark mode, on <html>. Until
 * Seti answers and the mods have started, it keeps the theme this browser showed last.
 */
function useShownTheme(): ThemeChoice & { schemes: readonly Scheme[] } {
  const chosen = useChosenTheme()
  const synced = useModsSynced()
  const themes = useThemes()
  const [lastShown] = useState(shownTheme)
  return useMemo(() => {
    if (chosen === undefined || !synced) {
      const shown = lastShown ?? NO_CHOICE
      return { ...shown, schemes: themeRegistry.get(shown.id)?.schemes ?? [] }
    }
    const { theme, flavour, accent } = resolveTheme(chosen, (id) => themes.find((entry) => entry.id === id))
    return { id: theme.id, flavour, accent, schemes: theme.schemes }
  }, [chosen, synced, themes, lastShown])
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<Mode>(storedMode)
  const chosen = useChosenTheme()
  const synced = useModsSynced()
  const shown = useShownTheme()
  const system: Scheme = usePrefersDark() ? 'dark' : 'light'
  const wanted = mode === 'system' ? system : mode
  const scheme = schemeFor(shown.schemes, wanted)
  const { id: themeId, flavour, accent } = shown

  useEffect(() => {
    applyTheme(window.document.documentElement, { themeId, scheme, flavour, accent })
    syncThemeColor()
    refitAgentColors()
    if (chosen !== undefined && synced) {
      rememberShown({ id: themeId, flavour, accent })
    }
  }, [scheme, themeId, flavour, accent, chosen, synced])

  const value = useMemo(() => {
    const base = chosen ?? { id: themeId, flavour, accent }
    return {
      mode,
      setMode: (next: Mode) => {
        rememberMode(next)
        setModeState(next)
      },
      scheme,
      themeId,
      setThemeId: (id: string) => void saveTheme({ ...base, id }),
      flavour,
      setFlavour: (next: string) => void saveTheme({ ...base, flavour: next }),
      accent,
      setAccent: (next: string) => void saveTheme({ ...base, accent: next }),
    }
  }, [mode, scheme, themeId, flavour, accent, chosen])

  const other: Scheme = scheme === 'dark' ? 'light' : 'dark'
  useCommands([
    {
      id: 'view.theme',
      title: 'Toggle theme',
      detail: `Switch to ${other}`,
      icon: other === 'dark' ? Moon : Sun,
      group: 'View',
      keywords: 'dark light mode colour color',
      run: () => {
        value.setMode(other)
      },
    },
  ])

  return <ThemeContext value={value}>{children}</ThemeContext>
}
