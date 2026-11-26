import { agentColorPreset } from '../agent-color.js'
import { bypassOn } from '../permissions.js'
import { accessStep } from './access-steps.js'
import { amountStep } from './amount-steps.js'
import { runtimeRefusal, SETI_NAMES, setiName, type SetiName } from './names.js'
import { SETI_PREFIX, USER, type SetiGrammar, type ValueRule } from './rules.js'
import { option, type CommandOption, type CommandWorld, type GrammarStep } from './world.js'

type ValuesGrammar = Extract<SetiGrammar, { kind: 'values' }>

const choose = (prompt: string, options: readonly CommandOption[]) =>
  ({ kind: 'choose', prompt, options, free: null, endRule: null }) satisfies GrammarStep

function nameOptions(world: CommandWorld): CommandOption[] {
  return SETI_NAMES.map((entry) =>
    option({
      token: `${SETI_PREFIX}${entry.name}`,
      key: entry.name,
      label: `/${SETI_PREFIX}${entry.name}`,
      detail: entry.description,
      unavailable: runtimeRefusal(entry.entry, world.caps),
    }),
  )
}

/** The value a setting holds now, as its grammar names it; null when the line cannot tell. */
function currentValue(name: string, world: CommandWorld): string | null {
  const { task } = world
  const onOff = (on: boolean) => (on ? 'on' : 'off')
  switch (name) {
    case 'sandbox':
      return onOff(task.sandbox)
    case 'bypass':
      return bypassOn(task.bypass_until) ? null : 'off'
    case 'control':
      return task.seti_control
    case 'updates':
      return task.input_mode
    case 'color':
      return task.color === null ? 'none' : agentColorPreset(task.color)
    case 'notify':
      return onOff(!task.notifications_muted)
    case 'pin':
      return onOff(task.pinned)
    default:
      return null
  }
}

function valueRefusal(name: string, world: CommandWorld): string | null {
  return name === 'sandbox' && !world.sandboxOn ? 'The sandbox is off in Settings, so this agent runs outside it' : null
}

/** A value's rule: in an ordered list, one above the current value confirms. */
function valueRule(grammar: ValuesGrammar, picked: ValueRule, current: string | null): ValueRule['rule'] {
  if (!grammar.ordered || current === null) {
    return picked.rule
  }
  const rank = (value: string) => grammar.values.findIndex((entry) => entry.value === value)
  return { ...picked.rule, confirm: picked.rule.confirm || rank(picked.value) > rank(current) }
}

function valuesStep(found: SetiName, grammar: ValuesGrammar, rest: readonly string[], world: CommandWorld) {
  const current = currentValue(found.name, world)
  const [picked, ...more] = rest
  if (picked === undefined) {
    const refusal = valueRefusal(found.name, world)
    const options = grammar.values.map((entry) =>
      option({
        token: entry.value,
        label: entry.label,
        current: entry.value === current,
        unavailable: refusal ?? (entry.value === current ? `Already ${entry.label.toLowerCase()}` : null),
      }),
    )
    return choose(grammar.values.map((entry) => entry.value).join(', '), options)
  }
  const entry = grammar.values.find((value) => value.value === picked)
  return entry === undefined || more.length > 0
    ? null
    : ({ kind: 'end', rule: valueRule(grammar, entry, current) } as const)
}

function workspaceStep(rest: readonly string[], world: CommandWorld, rule: ValueRule['rule']): GrammarStep | null {
  if (rest.length > 0) {
    return rest.length === 1 ? { kind: 'end', rule } : null
  }
  const options = (world.workspaces ?? []).map((workspace) =>
    option({
      token: /\s/.test(workspace.name) ? workspace.id : workspace.name,
      key: workspace.id,
      label: workspace.name,
      current: workspace.id === world.task.workspace_id,
      unavailable: workspace.id === world.task.workspace_id ? 'This agent is in it already' : null,
    }),
  )
  return choose('a workspace', options)
}

function openStep(tabs: readonly string[], rest: readonly string[]): GrammarStep | null {
  if (rest.length === 0) {
    return tabs.length === 0
      ? { kind: 'end', rule: USER }
      : {
          ...choose(
            'a tab',
            tabs.map((tab) => option({ token: tab, label: tab })),
          ),
          endRule: USER,
        }
  }
  return rest.length === 1 && tabs.includes(rest[0] ?? '') ? { kind: 'end', rule: USER } : null
}

function grammarStep(found: SetiName, rest: readonly string[], world: CommandWorld): GrammarStep | null {
  const { grammar } = found
  switch (grammar.kind) {
    case 'run':
      return rest.length === 0 ? { kind: 'end', rule: grammar.rule } : null
    case 'open':
      return openStep(grammar.tabs, rest)
    case 'values':
      return valuesStep(found, grammar, rest, world)
    case 'workspace':
      return workspaceStep(rest, world, grammar.rule)
    case 'amount':
      return amountStep(grammar, rest, world)
    case 'text':
      return rest.length === 0 ? { kind: 'rest', prompt: grammar.prompt, max: grammar.max, rule: grammar.rule } : null
    case 'access':
      return accessStep(rest, world)
    case 'alias':
      return accessStep([grammar.target, ...rest], world)
    case 'within':
      return null
  }
}

/**
 * What the next word may be after the keys matched so far, the first being the command's name;
 * null when those keys make no command.
 */
export function stepAt(keys: readonly string[], world: CommandWorld): GrammarStep | null {
  const [name, ...rest] = keys
  if (name === undefined) {
    return choose('a command', nameOptions(world))
  }
  const found = setiName(name)
  return found === undefined ? null : grammarStep(found, rest, world)
}
