import { AGENT_SETTING_ENTRIES, type AgentSettingEntry } from '../agent-settings.js'
import { meetsNeeds, type AgentCapabilities } from '../runtimes/capabilities.js'
import { grammarOf, SETI_PREFIX, type SetiGrammar } from './rules.js'
import type { CommandSource } from './world.js'

type SettingId = AgentSettingEntry['id']

/** One line for each command in the menu; a setting without one shows its label. */
const DESCRIPTIONS: Partial<Readonly<Record<SettingId, string>>> = {
  role: 'Open the role this agent plays',
  workspace: 'Move this agent to another workspace',
  color: "Set this agent's colour",
  notify: "Notify your devices when this agent's turns end",
  access: 'Turn what this agent may reach on or off: SSH, AWS, MCP, plugins, packs, hosts',
  mcp: 'Turn an MCP server on or off for this agent',
  control: "How far this agent's Seti tools reach",
  sandbox: 'Run this agent in the sandbox or outside it',
  bypass: 'Run tools without asking for some hours',
  rules: "Open this agent's permission rules",
  chat: 'Take part in the group chat',
  channels: "Open this agent's channels",
  threads: 'Open the threads this agent follows',
  updates: 'Wake the agent, queue updates for its next turn, or hold them',
  memory: "Set this agent's memory cap",
  cpu: "Set this agent's CPU cap",
  compaction: "Open this agent's compaction rule",
  dream: "Dream now: tidy this agent's memory and unused subscriptions",
  nightly: 'Dream every night',
  runtime: 'Open Continue on, to carry on in another runtime',
  restart: 'Restart the session; the conversation stays, tools reload',
  archive: 'Archive this agent until you restore it',
  rename: 'Rename this agent',
  pin: 'Pin this agent to the top of the list',
  settings: "Open this agent's settings",
}

/** A command the line can start with. */
export interface SetiName {
  name: string
  entry: AgentSettingEntry
  grammar: SetiGrammar
  description: string
}

/** Every Seti command, one per setting, except those reached only inside `/seti:access`. */
export const SETI_NAMES: readonly SetiName[] = AGENT_SETTING_ENTRIES.flatMap((entry) => {
  const grammar = grammarOf(entry)
  return grammar.kind === 'within'
    ? []
    : [{ name: entry.id, entry, grammar, description: DESCRIPTIONS[entry.id] ?? entry.label }]
})

export const setiName = (name: string): SetiName | undefined => SETI_NAMES.find((entry) => entry.name === name)

/** Why the agent's runtime cannot take the command, such as "Not on Codex"; null when it can. */
export function runtimeRefusal(entry: Pick<AgentSettingEntry, 'needs'>, caps: AgentCapabilities | null): string | null {
  return meetsNeeds(caps, entry.needs) || caps === null ? null : `Not on ${caps.label}`
}

/** The line starts a Seti command: `/seti:` in any case, after leading spaces. */
export const isSetiLine = (text: string): boolean => text.trimStart().toLowerCase().startsWith(`/${SETI_PREFIX}`)

/** The sources a line reads beyond the agent itself, by its command's grammar. */
export function sourcesOf(text: string): CommandSource[] {
  const word = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? ''
  const found = setiName(word.startsWith(SETI_PREFIX) ? word.slice(SETI_PREFIX.length) : word)
  switch (found?.grammar.kind) {
    case 'access':
    case 'alias':
      return ['access', 'credentials']
    case 'workspace':
      return ['workspaces']
    case 'amount':
      return [found.grammar.source]
    case 'open':
    case 'run':
    case 'text':
    case 'values':
    case 'within':
    case undefined:
      return []
  }
}
