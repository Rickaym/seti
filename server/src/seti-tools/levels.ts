import type { SetiControlLevel } from '@seti/shared'
import { SETI_TOOLS } from './catalog.js'
import { modActionTools } from './mod-actions.js'
import { REQUEST_TOOLS } from './requests.js'
import { SELF_TOOLS } from './self.js'
import { HANDOFF_TOOLS } from './team.js'
import type { SetiTool } from './tool.js'

/** Tools every agent gets at any level: its own status line and file handoffs. */
export const EVERY_AGENT: readonly SetiTool[] = [...SELF_TOOLS, ...HANDOFF_TOOLS]

/** Tools that act on one agent, by the argument that names it; at Self that agent is the caller. */
export const ON_ONE_AGENT: Readonly<Record<string, string>> = {
  get_task: 'task',
  agent_access: 'task',
  list_processes: 'task',
  stop_process: 'task',
  list_subtasks: 'task',
  get_subtask: 'task',
  find_in_transcript: 'task',
  rename_agent: 'task',
  pin_agent: 'task',
  set_agent_color: 'task',
  set_update_mode: 'task',
  add_agent_repo: 'task',
  add_agent_directory: 'task',
  remove_from_agent: 'task',
  set_agent_working_directory: 'task',
  link_pr: 'task',
  unlink_pr: 'task',
  link_context_pack: 'task',
  unlink_context_pack: 'task',
  set_agent_role: 'task',
  set_agent_group_chat: 'task',
  subscribe_channel: 'subscriber',
  unsubscribe_channel: 'subscriber',
}

/** Tools that read Seti and reach no agent, so a Self agent knows what Seti offers. */
export const READS_SETI: readonly string[] = [
  'get_memory_cap',
  'get_security_settings',
  'list_context_packs',
  'get_context_pack',
  'list_context_files',
  'read_context_file',
  'list_channels',
  'get_channel',
  'list_repos',
  'get_repo',
  'list_mcp_servers',
  'list_plugins',
]

function named(name: string): SetiTool {
  const found = SETI_TOOLS.find((entry) => entry.name === name)
  if (found === undefined) {
    throw new Error(`There is no seti tool named ${name}`)
  }
  return found
}

const argsOf = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null ? { ...(args as Record<string, unknown>) } : {}

/** The tool without the argument that names an agent: Seti fills in the caller instead. */
function onCaller(entry: SetiTool, key: string): SetiTool {
  const keep = (args: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(args).filter(([name]) => name !== key))
  return {
    ...entry,
    description: `${entry.description} At Seti control Self it acts on you.`,
    input: keep(entry.input) as SetiTool['input'],
    call: async (args, ctx) => entry.call({ ...keep(argsOf(args)), [key]: ctx.caller.id }, ctx),
  }
}

const SELF_LEVEL: readonly SetiTool[] = [
  ...EVERY_AGENT,
  ...REQUEST_TOOLS,
  ...Object.entries(ON_ONE_AGENT).map(([name, key]) => onCaller(named(name), key)),
  ...READS_SETI.map(named),
]

const FULL_LEVEL: readonly SetiTool[] = [...EVERY_AGENT, ...REQUEST_TOOLS, ...SETI_TOOLS]

/** The seti tools an agent gets at each Seti control level, with those of the mods that are on. */
export function toolsFor(level: SetiControlLevel): readonly SetiTool[] {
  switch (level) {
    case 'off':
      return EVERY_AGENT
    case 'self':
      return [...SELF_LEVEL, ...modActionTools(level)]
    case 'full':
      return [...FULL_LEVEL, ...modActionTools(level)]
  }
}
