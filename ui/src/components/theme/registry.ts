import { DEFAULT_THEME, Registry, type ThemeChoice } from '@seti/shared'
import { useSyncExternalStore } from 'react'

export type Scheme = 'light' | 'dark'

interface ThemeOption {
  id: string
  label: string
  /** The option's colour as CSS, for its swatch. */
  swatch: string
}

/** A choice a theme offers beyond light and dark, kept with the user's theme. */
export interface ThemeOptions {
  options: readonly ThemeOption[]
  fallback: string
}

/** Background, accent and text as CSS colours, for the theme picker. */
export type Swatch = Readonly<Record<'background' | 'primary' | 'foreground', string>>

/** A set of token values on <html>, scoped by `data-theme` to the theme's id. */
export interface ThemeDefinition {
  /** `default`, or a mod's theme as `<mod>.<theme>`. */
  id: string
  label: string
  description: string
  /** One scheme pins the theme to it and the light/dark control no longer applies. */
  schemes: readonly [Scheme, ...Scheme[]]
  swatch: Partial<Record<Scheme, Swatch | undefined>>
  /** Dark palettes, set as `data-flavour` on <html>. */
  flavours?: ThemeOptions
  /** Accent colours, set as `data-accent` on <html>. */
  accents?: ThemeOptions
}

const DEFAULT_SWATCH: Swatch = {
  background: 'var(--swatch-default-background)',
  primary: 'var(--swatch-default-primary)',
  foreground: 'var(--swatch-default-foreground)',
}

const DEFAULT: ThemeDefinition = {
  id: DEFAULT_THEME,
  label: 'Default',
  description: 'The Seti colours',
  schemes: ['light', 'dark'],
  swatch: { light: DEFAULT_SWATCH, dark: DEFAULT_SWATCH },
}

/** Seti's own theme and the ones enabled mods add; the default is always here. */
export const themeRegistry = new Registry<ThemeDefinition>('theme', (theme) => theme.id)

themeRegistry.register(DEFAULT)

/** Every theme the user can pick now, as mods turn on and off. */
export const useThemes = (): readonly ThemeDefinition[] =>
  useSyncExternalStore(themeRegistry.subscribe, themeRegistry.list)

/** The scheme to render: the chosen one when the theme offers it, else the theme's first. */
export function schemeFor(schemes: readonly Scheme[], wanted: Scheme): Scheme {
  return schemes.includes(wanted) ? wanted : (schemes[0] ?? wanted)
}

/** The stored option when the choice offers it, else its fallback; null for a theme without it. */
export function choiceFor(choice: ThemeOptions | undefined, stored: string | null): string | null {
  if (choice === undefined) {
    return null
  }
  return choice.options.find((entry) => entry.id === stored)?.id ?? choice.fallback
}

export interface ResolvedTheme {
  theme: ThemeDefinition
  flavour: string | null
  accent: string | null
}

/** What <html> shows for a choice: the chosen theme while a mod provides it, else the default. */
export function resolveTheme(
  choice: ThemeChoice | null,
  themeOf: (id: string) => ThemeDefinition | undefined = themeRegistry.get,
): ResolvedTheme {
  const theme = (choice === null ? undefined : themeOf(choice.id)) ?? DEFAULT
  return {
    theme,
    flavour: choiceFor(theme.flavours, choice?.flavour ?? null),
    accent: choiceFor(theme.accents, choice?.accent ?? null),
  }
}
