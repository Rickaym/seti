import type { ModCategory, ModInfo } from '@seti/shared'

export const MOD_FILTERS = ['all', 'enabled', 'disabled', 'bundled', 'installed', 'updates'] as const
export type ModFilter = (typeof MOD_FILTERS)[number]

export const FILTER_LABELS: Readonly<Record<ModFilter, string>> = {
  all: 'All',
  enabled: 'Enabled',
  disabled: 'Disabled',
  bundled: 'Bundled',
  installed: 'Installed',
  updates: 'Updates',
}

export const CATEGORY_LABELS: Readonly<Record<ModCategory, string>> = {
  themes: 'Themes',
  viewers: 'Viewers',
  channels: 'Channels',
  integrations: 'Integrations',
  agents: 'Agents',
  keyboard: 'Keyboard',
  appearance: 'Appearance',
  other: 'Other',
}

/** What an empty filter says, with no search words. */
export const EMPTY_FILTER: Readonly<Record<ModFilter, string>> = {
  all: 'Seti has no mods.',
  enabled: 'No mod is on.',
  disabled: 'Every mod is on.',
  bundled: 'No mod ships with this Seti.',
  installed: 'No mod is installed yet. Turn on Developer mode and press Add to install one.',
  updates: 'Every mod is up to date.',
}

const FILTERS: Readonly<Record<ModFilter, (mod: ModInfo) => boolean>> = {
  all: () => true,
  enabled: (mod) => mod.enabled,
  disabled: (mod) => !mod.enabled,
  bundled: (mod) => mod.tier !== 'third-party',
  installed: (mod) => mod.tier === 'third-party',
  updates: (mod) => (mod.install?.pending ?? null) !== null,
}

export const inFilter = (mod: ModInfo, filter: ModFilter): boolean => FILTERS[filter](mod)

/** Who publishes the mod: its author, or Seti for the mods Seti ships. */
export const publisherOf = (mod: ModInfo): string =>
  mod.author ?? (mod.tier === 'third-party' ? 'Unknown publisher' : 'Seti')

const categoriesOf = (mod: ModInfo) => (mod.manifest?.categories ?? []).map((category) => CATEGORY_LABELS[category])

/** Whether each query word is in the mod's names, id, description, publisher or categories. */
export function matchesQuery(mod: ModInfo, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = [mod.display_name, mod.name, mod.id, mod.description, publisherOf(mod), ...categoriesOf(mod)]
    .join(' ')
    .toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/** What a required mod is, wherever Seti explains why it has no switch. */
export const REQUIRED_NOTE = 'Part of Seti, so it is always on.'

export type BadgeTone = 'muted' | 'primary' | 'destructive'

export interface ModBadge {
  label: string
  tone: BadgeTone
  hint: string
}

/** Where a mod came from: part of Seti, shipped with it, or none for a third-party mod. */
function originBadge(mod: ModInfo): ModBadge | null {
  if (mod.required) {
    return { label: 'Core', tone: 'muted', hint: REQUIRED_NOTE }
  }
  return mod.tier === 'third-party' ? null : { label: 'Bundled', tone: 'muted', hint: 'Ships with Seti' }
}

/** The short facts beside a mod's name: where it came from and what waits on it. */
export function modBadges(mod: ModInfo): ModBadge[] {
  const install = mod.install
  const error = mod.problem ?? install?.last_error ?? null
  const badges: (ModBadge | false)[] = [
    originBadge(mod) ?? false,
    install?.source_kind === 'dev' && {
      label: 'Dev',
      tone: 'muted',
      hint: 'Loaded from a folder while Developer mode is on',
    },
    (install?.pending ?? null) !== null && {
      label: 'Update available',
      tone: 'primary',
      hint: 'Open it to see what the update changes',
    },
    mod.restart &&
      mod.enabled && { label: 'Restart needed', tone: 'muted', hint: 'Takes full effect after Seti restarts' },
    mod.held_by_safe_mode && { label: 'Safe mode', tone: 'muted', hint: 'Off while safe mode is on' },
    error !== null && { label: 'Error', tone: 'destructive', hint: error },
  ]
  return badges.filter((badge) => badge !== false)
}

/** How many mods each filter shows, for the counts on the filter tabs. */
export const filterCounts = (mods: readonly ModInfo[]): Record<ModFilter, number> =>
  Object.fromEntries(MOD_FILTERS.map((filter) => [filter, mods.filter(FILTERS[filter]).length])) as Record<
    ModFilter,
    number
  >

/** Where a detail route points: the add page, or a mod and one of its tabs. */
export type ModsRoute = { kind: 'list' } | { kind: 'add' } | { kind: 'mod'; id: string; tab: string | null }

/** `#settings/mods/add` adds a mod; `#settings/mods/<id>/<tab>` opens a mod at a tab. */
export function modsRoute(detail: string | null): ModsRoute {
  if (detail === null || detail === '') {
    return { kind: 'list' }
  }
  if (detail === 'add') {
    return { kind: 'add' }
  }
  const [id = '', tab] = detail.split('/')
  return { kind: 'mod', id, tab: tab ?? null }
}

export const TAB_LABELS = {
  details: 'Details',
  permissions: 'Permissions',
  settings: 'Settings',
  contributes: 'Contributes',
  changelog: 'Changelog',
  versions: 'Versions',
} as const
export type TabKey = keyof typeof TAB_LABELS

/** The tabs a mod has: Settings only with settings, Versions only for a third-party install. */
export function tabsOf(mod: ModInfo): TabKey[] {
  const contributes = mod.manifest?.contributes
  const settings = Object.keys(contributes?.settings ?? {}).length + (contributes?.notifications.length ?? 0) > 0
  return [
    'details',
    'permissions',
    ...(settings ? (['settings'] as const) : []),
    'contributes',
    'changelog',
    ...(mod.install === null ? [] : (['versions'] as const)),
  ]
}

/** The tab a route names, or Details when it names none the mod has. */
export const tabOf = (mod: ModInfo, wanted: string | null): TabKey =>
  tabsOf(mod).find((tab) => tab === wanted) ?? 'details'
