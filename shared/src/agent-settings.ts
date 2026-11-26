import type { AgentCapabilityName } from './runtimes/capabilities.js'

/**
 * Where a setting sits: a tab of the agent's settings, their footer, the access dialog or the
 * agent's menu; null for a command that is no row anywhere.
 */
export type AgentSettingPlace = AgentSettingTab | 'footer' | 'dialog' | 'menu'

/** The tabs of the agent's settings, which `/settings` opens. */
export const AGENT_SETTING_TABS = ['general', 'access', 'team', 'session'] as const
export type AgentSettingTab = (typeof AGENT_SETTING_TABS)[number]

/** A switch, one of several values, something done once, or a dialog that holds the choice. */
export type AgentSettingKind = 'toggle' | 'choice' | 'action' | 'dialog'

/** One thing a user changes or does from an agent's settings, as every surface reads it. */
export interface AgentSetting {
  id: string
  label: string
  place: AgentSettingPlace | null
  kind: AgentSettingKind
  /** A security setting: only the user changes it, never the EA, an agent or a mod. */
  security: boolean
  applies: 'now' | 'next_turn'
  /** What the agent's runtime must offer for the setting to show. */
  needs: readonly AgentCapabilityName[]
}

const setting = <const I extends string, const P extends AgentSettingPlace | null>(
  id: I,
  label: string,
  place: P,
  kind: AgentSettingKind,
) => ({
  id,
  label,
  place,
  kind,
  security: false,
  applies: 'now' as AgentSetting['applies'],
  needs: [] as readonly AgentCapabilityName[],
})

const NEXT = 'next_turn'

/** Every setting of an agent, in the order the settings show them. */
export const AGENT_SETTING_ENTRIES = [
  { ...setting('role', 'Role', 'general', 'choice'), applies: NEXT },
  setting('workspace', 'Workspace', 'general', 'choice'),
  setting('color', 'Color', 'general', 'choice'),
  setting('notify', 'Notify', 'general', 'toggle'),
  {
    ...setting('credential', 'Credentials', 'access', 'choice'),
    security: true,
    applies: NEXT,
  },
  {
    ...setting('access', 'Services', 'access', 'dialog'),
    applies: NEXT,
  },
  {
    ...setting('mcp', 'MCP servers', 'dialog', 'choice'),
    applies: NEXT,
    needs: ['mcp_servers'],
  },
  { ...setting('control', 'Seti control', 'dialog', 'choice'), security: true, applies: NEXT },
  {
    ...setting('sandbox', 'Isolation', 'access', 'toggle'),
    security: true,
    applies: NEXT,
    needs: ['unsandboxed'],
  },
  { ...setting('home', 'Home folders', 'access', 'action'), security: true, applies: NEXT },
  {
    ...setting('bypass', 'Bypass', 'access', 'choice'),
    security: true,
    needs: ['bypass'],
  },
  { ...setting('rules', 'Rules', 'access', 'dialog'), security: true },
  setting('chat', 'Group chat', 'team', 'toggle'),
  setting('channels', 'Channels', 'team', 'dialog'),
  setting('threads', 'Threads', 'team', 'dialog'),
  setting('updates', 'Updates', 'team', 'choice'),
  setting('memory', 'Memory', 'session', 'choice'),
  setting('cpu', 'CPU', 'session', 'choice'),
  { ...setting('compaction', 'Compaction', 'session', 'choice'), applies: NEXT, needs: ['compaction'] },
  {
    ...setting('dream', 'Dream now', 'footer', 'action'),
    needs: ['dreams'],
  },
  { ...setting('nightly', 'Nightly', 'footer', 'toggle'), needs: ['dreams'] },
  setting('runtime', 'Continue on', 'footer', 'choice'),
  setting('restart', 'Restart session', 'footer', 'action'),
  setting('archive', 'Archive', 'footer', 'action'),
  setting('rename', 'Rename', 'menu', 'action'),
  setting('pin', 'Pin', 'menu', 'toggle'),
  setting('settings', 'Settings', null, 'dialog'),
] as const satisfies readonly AgentSetting[]

export type AgentSettingEntry = (typeof AGENT_SETTING_ENTRIES)[number]

/** The id of a row in one tab of the agent's settings. */
export type TabSettingId<T extends AgentSettingTab> = Extract<AgentSettingEntry, { place: T }>['id']

/** Names only Seti's settings take: no mod may add a slash command of one of them. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(AGENT_SETTING_ENTRIES.map((entry) => entry.id))
