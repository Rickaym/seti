import { parseComposer, type ComposerCommand } from './commands.js'
import { meetsNeeds, type AgentCapabilities, type AgentCapabilityName } from './runtimes/capabilities.js'

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

/** The slash command of a setting, which Seti runs itself and never sends to the agent. */
export interface AgentSettingCommand {
  name: string
  /** One line for the composer's menu. */
  description: string
  argumentHint: string
}

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
  command: AgentSettingCommand | null
}

const command = (name: string, description: string, argumentHint = ''): AgentSettingCommand => ({
  name,
  description,
  argumentHint,
})

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
  command: null as AgentSettingCommand | null,
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
    command: command('credential', "Pick the credential this agent's sandbox uses", '[name]'),
  },
  {
    ...setting('access', 'Services', 'access', 'dialog'),
    applies: NEXT,
    command: command('access', 'Open what this agent may reach: SSH, AWS, MCP servers, packs'),
  },
  {
    ...setting('mcp', 'MCP servers', 'dialog', 'choice'),
    applies: NEXT,
    needs: ['mcp_servers'],
    command: command('mcp', 'List MCP servers, or turn one on or off for this agent', '[server] [on|off|default]'),
  },
  { ...setting('control', 'Seti control', 'dialog', 'choice'), security: true, applies: NEXT },
  {
    ...setting('sandbox', 'Isolation', 'access', 'toggle'),
    security: true,
    applies: NEXT,
    needs: ['unsandboxed'],
    command: command('sandbox', 'Run this agent in the sandbox or outside it', '[on|off]'),
  },
  { ...setting('home', 'Home folders', 'access', 'action'), security: true, applies: NEXT },
  {
    ...setting('bypass', 'Bypass', 'access', 'choice'),
    security: true,
    needs: ['bypass'],
    command: command('bypass', 'Run tools without asking for some hours', '[2|8|24|off]'),
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
    command: command('settings', "Open this agent's settings", '[general|access|team|session]'),
  },
] as const satisfies readonly AgentSetting[]

export type AgentSettingEntry = (typeof AGENT_SETTING_ENTRIES)[number]

/** The id of a row in one tab of the agent's settings. */
export type TabSettingId<T extends AgentSettingTab> = Extract<AgentSettingEntry, { place: T }>['id']

type CommandEntry = Extract<AgentSettingEntry, { command: AgentSettingCommand }>

/** The settings that have a slash command, with it. */
export const COMMAND_SETTINGS = AGENT_SETTING_ENTRIES.filter((entry): entry is CommandEntry => entry.command !== null)
export type CommandSetting = (typeof COMMAND_SETTINGS)[number]
export type CommandSettingId = CommandSetting['id']

/** Names only Seti's own commands take: no mod may add a slash command of one of them. */
export const RESERVED_COMMAND_NAMES: ReadonlySet<string> = new Set(COMMAND_SETTINGS.map((entry) => entry.command.name))

/** The setting commands an agent's runtime can take, as the composer lists them. */
export const settingCommands = (caps: AgentCapabilities | null): ComposerCommand[] =>
  COMMAND_SETTINGS.filter((entry) => meetsNeeds(caps, entry.needs)).map(({ command: c }) => ({
    name: c.name,
    description: c.description,
    argument_hint: c.argumentHint,
    aliases: [],
    builtin: true,
    unsupported: null,
  }))

/** A composer line that is a setting command: the setting and the text after its name. */
export interface SettingCommandLine {
  setting: CommandSetting
  args: string
}

/** The setting command the composer text is, or null for a message or any other command. */
export function parseSettingCommand(text: string): SettingCommandLine | null {
  const input = parseComposer(text)
  if (input.mode !== 'slash') {
    return null
  }
  const name = input.name.toLowerCase()
  const found = COMMAND_SETTINGS.find((entry) => entry.command.name === name)
  return found === undefined ? null : { setting: found, args: input.args }
}

/** Why the text cannot go to the agent as a prompt: it is a setting command; null when it can. */
export function settingCommandRefusal(text: string): string | null {
  const line = parseSettingCommand(text)
  return line === null
    ? null
    : `/${line.setting.command.name} is a Seti command: it runs from the agent's reply box and never goes to the agent`
}
