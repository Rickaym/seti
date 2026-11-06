import { createContext, useContext } from 'react'
import type { Scheme } from './registry'

const MODES = ['dark', 'light', 'system'] as const
export type Mode = (typeof MODES)[number]

export const isMode = (value: string | null): value is Mode => MODES.some((m) => m === value)

interface ThemeState {
  /** Light, dark or the system's choice; a single-scheme theme overrides it. */
  mode: Mode
  setMode: (mode: Mode) => void
  scheme: Scheme
  /** The theme shown: the chosen one while it is registered, else the default. */
  themeId: string
  setThemeId: (id: string) => void
  /** The active theme's dark flavour, or null when it offers none. */
  flavour: string | null
  setFlavour: (id: string) => void
  /** The active theme's accent, or null when it offers none. */
  accent: string | null
  setAccent: (id: string) => void
}

export const ThemeContext = createContext<ThemeState | null>(null)

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return context
}
