import type { AgentCapabilityName } from './runtimes/capabilities.js'

/** Where a setting sits in the agent's settings; null for a command that is not a row there. */
type AgentSettingPlace = 'general' | 'access' | 'team' | 'session' | 'footer' | 'menu'

/** The tabs of the agent's settings, which `/settings` opens. */
const AGENT_SETTING_TABS = ['general', 'access', 'team', 'session'] as const

/** A switch, one of several values, something done once, or a dialog that holds the choice. */
type AgentSettingKind = 'toggle' | 'choice' | 'action' | 'dialog'

/** The slash command of a setting, which Seti runs itself and never sends to the agent. */
interface AgentSettingCommand {
  name: string
  /** One line for the composer's menu. */
  description: string
  argumentHint: string
  /** The words its first argument takes when they are fixed, else null. */
  values: readonly string[] | null
}

/** One thing a user changes or does from an agent's settings, as every surface reads it. */
interface AgentSetting {
  id: string
  label: string
  place: AgentSettingPlace | null
  kind: AgentSettingKind
  /** A security setting: only the user changes it, never the EA, an agent or a mod. */
  security: boolean
  applies: 'now' | 'next_turn'
  /** What the agent's runtime must offer for the setting to show. */
  needs: readonly AgentCapabilityName[]
  command: AgentSettingCommand | null
}

const ON_OFF = ['on', 'off'] as const

const command = (
  name: string,
  description: string,
  argumentHint = '',
  values: readonly string[] | null = null,
): AgentSettingCommand => ({ name, description, argumentHint, values })

const setting = (id: string, label: string, place: AgentSettingPlace | null, kind: AgentSettingKind): AgentSetting => ({
  id,
  label,
  place,
  kind,
  security: false,
  applies: 'now',
  needs: [],
  command: null,
})

const NEXT = 'next_turn'

/** Every setting of an agent, in the order the settings show them. */
const AGENT_SETTINGS: readonly AgentSetting[] = [
  { ...setting('role', 'Role', 'general', 'choice'), applies: NEXT },
  setting('workspace', 'Workspace', 'general', 'choice'),
  setting('color', 'Color', 'general', 'choice'),
  setting('notify', 'Notify', 'general', 'toggle'),
  {
    ...setting('credential', 'Credentials', 'access', 'choice'),
    security: true,
    applies: NEXT,
    command: command('credential', "Pick the credential this agent's sandbox uses", '[name]'),
  },
  {
    ...setting('access', 'Services', 'access', 'dialog'),
    applies: NEXT,
    command: command('access', 'Open what this agent may reach: SSH, AWS, MCP servers, packs'),
  },
  {
    ...setting('mcp', 'MCP servers', 'access', 'choice'),
    applies: NEXT,
    needs: ['mcp_servers'],
    command: command('mcp', 'List MCP servers, or turn one on or off for this agent', '[server] [on|off|default]'),
  },
  { ...setting('control', 'Seti control', 'access', 'choice'), security: true, applies: NEXT },
  {
    ...setting('sandbox', 'Isolation', 'access', 'toggle'),
    security: true,
    applies: NEXT,
    needs: ['unsandboxed'],
    command: command('sandbox', 'Run this agent in the sandbox or outside it', '[on|off]', ON_OFF),
  },
  { ...setting('home', 'Home folders', 'access', 'action'), security: true, applies: NEXT },
  {
    ...setting('bypass', 'Bypass', 'access', 'choice'),
    security: true,
    needs: ['bypass'],
    command: command('bypass', 'Run tools without asking for some hours', '[2|8|24|off]', ['2', '8', '24', 'off']),
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
    command: command('dream', "Dream now: tidy this agent's memory and unused subscriptions"),
  },
  { ...setting('nightly', 'Nightly', 'footer', 'toggle'), needs: ['dreams'] },
  setting('runtime', 'Continue on', 'footer', 'choice'),
  {
    ...setting('restart', 'Restart session', 'footer', 'action'),
    command: command('restart', 'Restart the session; the conversation stays, tools reload'),
  },
  {
    ...setting('archive', 'Archive', 'footer', 'action'),
    command: command('archive', 'Archive this agent until you restore it'),
  },
  { ...setting('rename', 'Rename', 'menu', 'action'), command: command('rename', 'Rename this agent', '[title]') },
  setting('pin', 'Pin', 'menu', 'toggle'),
  {
    ...setting('settings', 'Settings', null, 'dialog'),
    command: command('settings', "Open this agent's settings", '[general|access|team|session]', AGENT_SETTING_TABS),
  },
]

/** The settings that have a slash command, with it. */
const COMMAND_SETTINGS = AGENT_SETTINGS.flatMap((entry) =>
  entry.command === null ? [] : [{ ...entry, command: entry.command }],
)

/** Names only Seti's own commands take: no mod may add a slash command of one of them. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(COMMAND_SETTINGS.map((entry) => entry.command.name))
