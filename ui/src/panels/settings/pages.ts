import type { ModSettingsPageProps } from '@seti/mod-api'
import { Registry, type Disposer } from '@seti/shared'
import {
  Bell,
  Blocks,
  BotMessageSquare,
  FolderGit2,
  Gauge,
  Hand,
  Headset,
  Info,
  KeyRound,
  Layers,
  LockKeyhole,
  Package,
  Plug,
  Puzzle,
  RadioTower,
  ScrollText,
  Share2,
  ShieldCheck,
  SlidersHorizontal,
  SquareSlash,
  UserRound,
  Users,
} from 'lucide-react'
import { useSyncExternalStore, type ComponentType } from 'react'
import { aboutParts } from '@/lib/mod-views'

/** Seti's own pages; a mod's page is keyed by the mod's id. */
export type SettingsPageKey =
  | 'general'
  | 'notifications'
  | 'ea'
  | 'about'
  | 'agents'
  | 'repos'
  | 'resources'
  | 'channels'
  | 'account'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'subagents'
  | 'signin'
  | 'sandbox'
  | 'permissions'
  | 'connections'
  | 'credentials'
  | 'ssh'
  | 'sharing'
  | 'audit'
  | 'mods'

const SETTINGS_GROUPS = ['App', 'Agents', 'Claude Code', 'Security', 'Mods'] as const
type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

/** What a page's view gets: its key and the detail of its route, such as a credential's id. */
export type SettingsViewProps = ModSettingsPageProps

interface SettingsPage {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  group: SettingsGroup
  /** More words the command palette finds the page by, old page names among them. */
  keywords?: string
  /** A mod's page; Seti's own pages render from the settings panel, which loads them lazily. */
  view?: ComponentType<SettingsViewProps>
}

/** Every settings page: Seti's own, and a page for each enabled mod with settings. */
export const settingsPages = new Registry<SettingsPage>('settings page', (page) => page.key)

const CORE_GROUPS: { group: SettingsGroup; pages: (Omit<SettingsPage, 'group'> & { key: SettingsPageKey })[] }[] = [
  {
    group: 'App',
    pages: [
      {
        key: 'general',
        label: 'General',
        icon: SlidersHorizontal,
        keywords: 'name appearance theme mode transcripts tool calls',
      },
      { key: 'notifications', label: 'Notifications', icon: Bell, keywords: 'push sound' },
      { key: 'ea', label: 'EA', icon: Headset, keywords: 'assistant voice microphone wake word' },
    ],
  },
  {
    group: 'Agents',
    pages: [
      {
        key: 'agents',
        label: 'Lifecycle',
        icon: BotMessageSquare,
        keywords: 'agents compaction compact restart resume repeat loop archive delete stale folders',
      },
      { key: 'repos', label: 'Repos', icon: FolderGit2, keywords: 'repositories checkouts warm caches' },
      { key: 'resources', label: 'Resources', icon: Gauge, keywords: 'memory cpu cap host usage' },
      { key: 'channels', label: 'Channels', icon: RadioTower, keywords: 'webhooks pollers reminders' },
    ],
  },
  {
    group: 'Claude Code',
    pages: [
      { key: 'account', label: 'Account', icon: UserRound, keywords: 'claude login usage plan' },
      { key: 'mcp', label: 'MCP servers', icon: Blocks },
      { key: 'plugins', label: 'Plugins', icon: Puzzle, keywords: 'marketplaces' },
      { key: 'skills', label: 'Skills', icon: SquareSlash, keywords: 'slash commands' },
      { key: 'subagents', label: 'Subagents', icon: Users, keywords: 'models' },
    ],
  },
  {
    group: 'Security',
    pages: [
      {
        key: 'signin',
        label: 'Sign-in',
        icon: LockKeyhole,
        keywords: 'passkeys sessions devices phones pair android',
      },
      { key: 'sandbox', label: 'Sandbox', icon: ShieldCheck, keywords: 'allowed hosts hidden paths' },
      { key: 'permissions', label: 'Permissions', icon: Hand, keywords: 'rules allow ask deny' },
      {
        key: 'connections',
        label: 'Connections',
        icon: Plug,
        keywords: 'secrets api keys tokens headers oauth service account named secrets header rules',
      },
      {
        key: 'credentials',
        label: 'Credentials',
        icon: Layers,
        keywords: 'credentials bundles claude token github aws ssh',
      },
      { key: 'ssh', label: 'SSH', icon: KeyRound, keywords: 'hosts keys' },
      { key: 'sharing', label: 'Sharing', icon: Share2, keywords: 'share public links' },
      { key: 'audit', label: 'Audit log', icon: ScrollText },
    ],
  },
  {
    group: 'Mods',
    pages: [{ key: 'mods', label: 'Mods', icon: Package, keywords: 'extensions add-ons safe mode bundled' }],
  },
]

for (const { group, pages } of CORE_GROUPS) {
  for (const page of pages) {
    settingsPages.register({ ...page, group })
  }
}

const ABOUT: SettingsPage = {
  key: 'about' satisfies SettingsPageKey,
  label: 'About',
  icon: Info,
  group: 'App',
  keywords: "what's new whats new changelog version update upgrade release",
}

let aboutListed: Disposer | null = null

/** About holds only what mods add to it, so it is listed only while one does. */
function listAbout(): void {
  const wanted = aboutParts.list().length > 0
  if (wanted && aboutListed === null) {
    aboutListed = settingsPages.register(ABOUT)
  } else if (!wanted && aboutListed !== null) {
    aboutListed()
    aboutListed = null
  }
}

aboutParts.subscribe(listAbout)

/** The pages by group, in the settings sidebar's order. */
export const settingsGroups = (pages: readonly SettingsPage[] = settingsPages.list()) =>
  SETTINGS_GROUPS.map((group) => ({ group, pages: pages.filter((page) => page.group === group) })).filter(
    (group) => group.pages.length > 0,
  )

/** The pages by group, as they change while mods turn on and off. */
export function useSettingsGroups() {
  return settingsGroups(useSyncExternalStore(settingsPages.subscribe, settingsPages.list))
}

export const isSettingsPage = (value: string | null): value is string => value !== null && settingsPages.has(value)

/** Pages that read the Claude Code probe, which they share while switching between them. */
const PROBED_PAGES = ['mcp', 'plugins', 'skills', 'subagents'] as const

export type ProbedPageKey = (typeof PROBED_PAGES)[number]

export const isProbedPage = (key: string): key is ProbedPageKey => (PROBED_PAGES as readonly string[]).includes(key)
