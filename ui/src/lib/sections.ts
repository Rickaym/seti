import type { ModSectionProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { Bot, FileText, Headset, Orbit, Settings } from 'lucide-react'
import { useSyncExternalStore, type ComponentType } from 'react'

type CoreSectionKey = 'ea' | 'home' | 'agents' | 'context' | 'settings'

/** Seti's own sections, or a mod's as `<mod>.<view>`. */
export type SectionKey = CoreSectionKey | `${string}.${string}`

const SECTION_GROUPS = ['Work', 'Configure', 'Mods'] as const

interface SidebarItem {
  key: SectionKey
  label: string
  icon: ComponentType<{ className?: string }>
  group: (typeof SECTION_GROUPS)[number]
  /** Alt with this digit opens it, numbered down the sidebar from 1; mods' sections have none. */
  digit: number | null
  /** A mod's section view; Seti's own sections render from the app's lazy panels. */
  view?: ComponentType<ModSectionProps>
}

/** The sections of the sidebar, Seti's and the ones enabled mods add. */
export const sectionRegistry = new Registry<SidebarItem>('section', (item) => item.key)

for (const item of [
  { key: 'ea', label: 'EA', icon: Headset, group: 'Work', digit: 1 },
  { key: 'home', label: 'Home', icon: Orbit, group: 'Work', digit: 2 },
  { key: 'agents', label: 'Agents', icon: Bot, group: 'Work', digit: 3 },
  { key: 'context', label: 'Context', icon: FileText, group: 'Configure', digit: 4 },
  { key: 'settings', label: 'Settings', icon: Settings, group: 'Configure', digit: 5 },
] as const) {
  sectionRegistry.register(item)
}

/** The sections by group, in the sidebar's order, leaving out empty groups. */
export const sectionGroups = (items: readonly SidebarItem[] = sectionRegistry.list()) =>
  SECTION_GROUPS.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter(
    (group) => group.items.length > 0,
  )

/** The sections by group, as they change while mods turn on and off. */
export function useSectionGroups() {
  return sectionGroups(useSyncExternalStore(sectionRegistry.subscribe, sectionRegistry.list))
}

export const isSectionKey = (value: string): value is SectionKey => sectionRegistry.has(value)

/** Where Seti opens without a section in the address, and where an unknown one leads. */
export const LANDING_SECTION: SectionKey = 'home'

/** The sections Alt and a digit open; only Seti's own have a digit. */
export const digitSections = () =>
  sectionRegistry.list().flatMap((item) => (item.digit === null ? [] : [{ key: item.key, digit: item.digit }]))

export const lastSectionDigit = Math.max(...digitSections().map((item) => item.digit))

export const sectionLabel = (key: SectionKey): string => sectionRegistry.get(key)?.label ?? key
