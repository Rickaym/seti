import { AGENT_COLOR_PRESETS } from '../agent-color.js'
import type { AgentSettingEntry } from '../agent-settings.js'
import { INPUT_MODES } from '../inputs.js'
import { BYPASS_HOURS } from '../permissions.js'
import type { AgentCapabilityName } from '../runtimes/capabilities.js'
import { SETI_CONTROL_LEVELS } from '../seti-control.js'

/** What every Seti command starts with, so it is plain that Seti answers it and not the runtime. */
export const SETI_PREFIX = 'seti:'

/** Who may use one operation, and whether the user confirms it first. */
export interface OpRule {
  /** The user runs it from the reply box. */
  user: boolean
  /** An agent may propose it for itself; only the user's Allow applies it. */
  propose: boolean
  /** It widens what the agent reaches, or cannot be undone lightly, so the user confirms it first. */
  confirm: boolean
}

const rule = (user: boolean, propose: boolean, confirm = false): OpRule => ({ user, propose, confirm })
/** The user's alone. */
export const USER = rule(true, false)
/** The user's, and an agent may propose it. */
const BOTH = rule(true, true)
/** The user's, confirmed first. */
const WIDEN = rule(true, false, true)

/** What `/seti:access` reaches: the access dialog's kinds, the agent's hosts and its credential. */
export const ACCESS_TARGETS = ['ssh', 'aws', 'mcp', 'plugin', 'pack', 'host', 'home', 'credential'] as const
export type AccessTarget = (typeof ACCESS_TARGETS)[number]

export const ACCESS_OPS = ['on', 'off', 'reset', 'add', 'remove'] as const
export type AccessOp = (typeof ACCESS_OPS)[number]

/** How a target names its item: from the agent's list, none, a host, or a credential. */
type ItemKind = 'list' | 'single' | 'host' | 'credential'

export interface AccessTargetRule {
  label: string
  description: string
  item: ItemKind
  ops: Partial<Record<AccessOp, OpRule>>
  /** Picking a credential, which takes no operation. */
  pick: OpRule | null
  needs: readonly AgentCapabilityName[]
  /** It means something only while the agent runs in the sandbox. */
  sandboxOnly: boolean
}

const target = (
  fields: Pick<AccessTargetRule, 'label' | 'description' | 'item' | 'ops'> & Partial<AccessTargetRule>,
): AccessTargetRule => ({ pick: null, needs: [], sandboxOnly: false, ...fields })

/** Each line is one decision: who runs an operation, who may propose it, whether it confirms. */
export const ACCESS_RULES: Readonly<Record<AccessTarget, AccessTargetRule>> = {
  ssh: target({
    label: 'SSH host',
    description: "Hosts from Seti's ssh config",
    item: 'list',
    ops: { on: WIDEN, off: BOTH, reset: WIDEN },
    sandboxOnly: true,
  }),
  aws: target({
    label: 'AWS',
    description: "The credential's AWS role",
    item: 'single',
    ops: { on: WIDEN, off: BOTH, reset: WIDEN },
    sandboxOnly: true,
  }),
  mcp: target({
    label: 'MCP server',
    description: 'MCP servers and connectors',
    item: 'list',
    ops: { on: BOTH, off: BOTH, reset: BOTH },
    needs: ['mcp_servers'],
  }),
  plugin: target({
    label: 'Plugin',
    description: "Seti's plugins",
    item: 'list',
    ops: { on: BOTH, off: BOTH, reset: BOTH },
    needs: ['plugins'],
  }),
  pack: target({
    label: 'Context pack',
    description: 'Context packs',
    item: 'list',
    ops: { on: BOTH, off: BOTH, reset: BOTH },
  }),
  host: target({
    label: 'Host',
    description: "This agent's own network allowlist",
    item: 'host',
    ops: { add: rule(true, true, true), remove: BOTH },
    sandboxOnly: true,
  }),
  home: target({
    label: 'Home folders',
    description: "Your home folders in this agent's sandbox",
    item: 'single',
    ops: { off: rule(true, true, true) },
  }),
  credential: target({
    label: 'Credential',
    description: "The credential this agent's sandbox uses",
    item: 'credential',
    ops: {},
    pick: WIDEN,
    sandboxOnly: true,
  }),
}

/** `/seti:access reset` and `/seti:access save`, which act on all of the agent's access at once. */
export const ACCESS_WHOLE = {
  reset: { description: "Drop this agent's own access choices", rule: WIDEN },
  save: { description: "Save this agent's access to its credential, after a preview", rule: USER },
} as const

export interface ValueRule {
  value: string
  label: string
  rule: OpRule
}

/** What a setting takes after its name. */
export type SetiGrammar =
  /** Runs at once, such as a restart. */
  | { kind: 'run'; rule: OpRule }
  /** Opens a dialog or a tab of the agent's settings in the browser. */
  | { kind: 'open'; tabs: readonly string[] }
  /** One of fixed values; `ordered` lists them weakest first, so a later one confirms. */
  | { kind: 'values'; values: readonly ValueRule[]; ordered: boolean }
  /** One of the workspaces. */
  | { kind: 'workspace'; rule: OpRule }
  /** A memory or CPU cap, or `default`. */
  | { kind: 'amount'; source: 'memory' | 'cpu'; rule: OpRule }
  /** Free words to the end of the line, such as a title. */
  | { kind: 'text'; prompt: string; max: number; rule: OpRule }
  | { kind: 'access' }
  /** A short name for `/seti:access <target>`. */
  | { kind: 'alias'; target: AccessTarget }
  /** A setting reached only inside `/seti:access`. */
  | { kind: 'within'; target: AccessTarget }

const value = (v: string, label: string, r: OpRule = USER): ValueRule => ({ value: v, label, rule: r })
const values = (list: readonly ValueRule[], ordered = false): SetiGrammar => ({ kind: 'values', values: list, ordered })
const onOff = (on: OpRule = USER, off: OpRule = USER) => values([value('on', 'On', on), value('off', 'Off', off)])

type SettingId = AgentSettingEntry['id']

/** Where a setting's kind alone does not say what it takes; every other setting follows its kind. */
const DECLARED_GRAMMAR: Partial<Readonly<Record<SettingId, SetiGrammar>>> = {
  access: { kind: 'access' },
  mcp: { kind: 'alias', target: 'mcp' },
  credential: { kind: 'within', target: 'credential' },
  home: { kind: 'within', target: 'home' },
  sandbox: onOff(USER, WIDEN),
  bypass: values([
    ...BYPASS_HOURS.map((hours) => value(String(hours), `${String(hours)} h`, WIDEN)),
    value('off', 'Off'),
  ]),
  control: values(
    SETI_CONTROL_LEVELS.map((level) => value(level, level.charAt(0).toUpperCase() + level.slice(1))),
    true,
  ),
  updates: values(INPUT_MODES.map((mode) => value(mode, mode.charAt(0).toUpperCase() + mode.slice(1)))),
  color: values([...AGENT_COLOR_PRESETS.map((preset) => value(preset.name, preset.name)), value('none', 'None')]),
  workspace: { kind: 'workspace', rule: USER },
  memory: { kind: 'amount', source: 'memory', rule: BOTH },
  cpu: { kind: 'amount', source: 'cpu', rule: BOTH },
  rename: { kind: 'text', prompt: 'a title', max: 200, rule: USER },
  restart: { kind: 'run', rule: WIDEN },
  archive: { kind: 'run', rule: WIDEN },
  settings: { kind: 'open', tabs: ['general', 'access', 'team', 'session'] },
}

/** What a setting takes: its declared grammar, else what its kind implies. */
export function grammarOf(entry: Pick<AgentSettingEntry, 'id' | 'kind'>): SetiGrammar {
  const declared = DECLARED_GRAMMAR[entry.id]
  if (declared !== undefined) {
    return declared
  }
  switch (entry.kind) {
    case 'toggle':
      return onOff()
    case 'action':
      return { kind: 'run', rule: USER }
    case 'choice':
    case 'dialog':
      return { kind: 'open', tabs: [] }
  }
}
