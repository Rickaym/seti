import type { ModSectionProps } from '@seti/mod-api'
import { Registry } from '@seti/shared'
import { Bot, FileText, Headset, MessageCircleQuestion, Orbit, Settings } from 'lucide-react'
import { useSyncExternalStore, type ComponentType } from 'react'
import { knowledgeWaiting } from '@/hooks/useKnowledgeWaiting'
import { openQuestionCount } from '@/hooks/useQuestions'
import type { CountStore } from '@/lib/polled'

type CoreSectionKey = 'ea' | 'home' | 'agents' | 'questions' | 'context' | 'settings'

/** Seti's own sections, or a mod's as `<mod>.<view>`. */
export type SectionKey = CoreSectionKey | `${string}.${string}`

const SECTION_GROUPS = ['Work', 'Configure', 'Mods'] as const

/** A count on a section's row, such as what waits there for the user; zero shows none. */
interface SectionBadge extends CountStore {
  /** What the count means, for screen readers, such as `2 questions wait on you`. */
  describe: (count: number) => string
}

export interface SidebarItem {
  key: SectionKey
  label: string
  icon: ComponentType<{ className?: string }>
  group: (typeof SECTION_GROUPS)[number]
  /** Alt with this digit opens it, numbered from 1 down the sidebar; Questions and mods have none. */
  digit: number | null
  /** Words besides its group that find it in the Go to palette. */
  keywords?: string
  badge?: SectionBadge
  /** A mod's section view; Seti's own sections render from the app's lazy panels. */
  view?: ComponentType<ModSectionProps>
}

/** The sections of the sidebar, Seti's and the ones enabled mods add. */
export const sectionRegistry = new Registry<SidebarItem>('section', (item) => item.key)

const counted = (count: number, one: string, many: string) => (count === 1 ? `1 ${one}` : `${String(count)} ${many}`)

const CORE_SECTIONS: readonly SidebarItem[] = [
  { key: 'ea', label: 'EA', icon: Headset, group: 'Work', digit: 1 },
  { key: 'home', label: 'Home', icon: Orbit, group: 'Work', digit: 2 },
  { key: 'agents', label: 'Agents', icon: Bot, group: 'Work', digit: 3 },
  {
    key: 'questions',
    label: 'Questions',
    icon: MessageCircleQuestion,
    group: 'Work',
    digit: null,
    keywords: 'answer agents ask secrets',
    badge: {
      ...openQuestionCount,
      describe: (count) => counted(count, 'question waits on you', 'questions wait on you'),
    },
  },
  {
    key: 'context',
    label: 'Context',
    icon: FileText,
    group: 'Configure',
    digit: 4,
    badge: {
      ...knowledgeWaiting,
      describe: (count) => counted(count, 'knowledge proposal waits', 'knowledge proposals wait'),
    },
  },
  { key: 'settings', label: 'Settings', icon: Settings, group: 'Configure', digit: 5 },
]

for (const item of CORE_SECTIONS) {
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

const NO_COUNT: CountStore = { subscribe: () => () => undefined, count: () => 0 }

/** The count on a section's row and what it means, as it changes; null while there is none. */
export function useSectionBadge(item: SidebarItem): { count: number; description: string } | null {
  const store = item.badge ?? NO_COUNT
  const count = useSyncExternalStore(store.subscribe, store.count)
  return count > 0 && item.badge !== undefined ? { count, description: item.badge.describe(count) } : null
}

export const isSectionKey = (value: string): value is SectionKey => sectionRegistry.has(value)

/** Where Seti opens without a section in the address, and where an unknown one leads. */
export const LANDING_SECTION: SectionKey = 'home'

/** The sections Alt and a digit open; only Seti's own have a digit. */
export const digitSections = () =>
  sectionRegistry.list().flatMap((item) => (item.digit === null ? [] : [{ key: item.key, digit: item.digit }]))

export const lastSectionDigit = Math.max(...digitSections().map((item) => item.digit))

export const sectionLabel = (key: SectionKey): string => sectionRegistry.get(key)?.label ?? key
