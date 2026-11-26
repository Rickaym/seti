import { accessBase, type AccessItem, type AccessKind } from '../access.js'
import { HTTPS_PORT, refusedHost } from '../change-requests.js'
import { meetsNeeds } from '../runtimes/capabilities.js'
import {
  ACCESS_OPS,
  ACCESS_RULES,
  ACCESS_TARGETS,
  ACCESS_WHOLE,
  type AccessOp,
  type AccessTarget,
  type AccessTargetRule,
  type OpRule,
} from './rules.js'
import { itemSource, option, type CommandOption, type CommandWorld, type FreeWord, type GrammarStep } from './world.js'

const ITEM_PROMPTS: Partial<Readonly<Record<AccessTarget, string>>> = {
  ssh: 'an SSH host',
  mcp: 'an MCP server',
  plugin: 'a plugin',
  pack: 'a context pack',
}

const LIST_KINDS: Partial<Readonly<Record<AccessTarget, AccessKind>>> = {
  ssh: 'ssh',
  aws: 'aws',
  mcp: 'mcp',
  plugin: 'plugin',
  pack: 'pack',
}

type ChooseStep = Extract<GrammarStep, { kind: 'choose' }>

const choose = (prompt: string, options: readonly CommandOption[], free: ChooseStep['free'] = null): ChooseStep => ({
  kind: 'choose',
  prompt,
  options,
  free,
  endRule: null,
})

const isTarget = (word: string): word is AccessTarget => (ACCESS_TARGETS as readonly string[]).includes(word)
const isOp = (word: string): word is AccessOp => (ACCESS_OPS as readonly string[]).includes(word)

/** The access the agent has applies: SSH, AWS, hosts and the credential only in the sandbox. */
const sandboxed = (world: CommandWorld) => world.access?.sandboxed ?? (world.sandboxOn && world.task.sandbox)

function targetRefusal(name: AccessTarget, world: CommandWorld): string | null {
  const rule = ACCESS_RULES[name]
  if (!meetsNeeds(world.caps, rule.needs) && world.caps !== null) {
    return `Not on ${world.caps.label}`
  }
  if (rule.sandboxOnly && !sandboxed(world)) {
    return 'Applies only while this agent runs in the sandbox'
  }
  if (name === 'home' && !world.task.home_access) {
    return 'This agent has no home folders in its sandbox'
  }
  const rules = [...Object.values(rule.ops), ...(rule.pick === null ? [] : [rule.pick])]
  if (world.author === 'agent' && !rules.some((entry) => entry.propose)) {
    const what = rule.label === 'AWS' ? rule.label : `the ${rule.label.toLowerCase()}`
    return `Only the user changes ${what}`
  }
  return null
}

function targetOptions(world: CommandWorld): CommandOption[] {
  const whole = (Object.keys(ACCESS_WHOLE) as (keyof typeof ACCESS_WHOLE)[]).map((name) =>
    option({
      token: name,
      label: name === 'reset' ? 'Reset' : 'Save',
      detail: ACCESS_WHOLE[name].description,
      unavailable: world.author === 'agent' ? 'Only the user does this' : null,
    }),
  )
  const targets = ACCESS_TARGETS.map((name) =>
    option({
      token: name,
      label: ACCESS_RULES[name].label,
      detail: ACCESS_RULES[name].description,
      unavailable: targetRefusal(name, world),
    }),
  )
  return [...targets, ...whole]
}

/** The word a line uses for an item: its name, or its id when the name has spaces. */
const itemToken = (item: AccessItem) => (/\s/.test(item.name) ? item.id : item.name)

const stateLine = (item: AccessItem) => `${item.enabled ? 'On' : 'Off'}, ${itemSource(item)}`

const itemsOf = (target: AccessTarget, world: CommandWorld): AccessItem[] =>
  (world.access?.items ?? []).filter((item) => item.kind === LIST_KINDS[target])

function itemOptions(target: AccessTarget, world: CommandWorld): CommandOption[] {
  return itemsOf(target, world).map((item) =>
    option({
      token: itemToken(item),
      key: item.id,
      label: item.name,
      detail: [stateLine(item), item.detail].filter((part) => part !== null).join(' - '),
      unavailable: item.unusable,
    }),
  )
}

function hostFree(word: string): FreeWord {
  const parsed = refusedHost.safeParse(word)
  if (!parsed.success) {
    return { refusal: parsed.error.issues[0]?.message ?? `${word} is not a host` }
  }
  return { option: option({ token: parsed.data, label: parsed.data, detail: 'Not on its allowlist yet' }) }
}

function hostOptions(world: CommandWorld): CommandOption[] {
  return (world.access?.hosts ?? []).map((entry) =>
    option({ token: entry, label: entry, detail: "On this agent's own allowlist" }),
  )
}

/** The state of the item the op acts on; null for a host, whose state is being on the list. */
interface ItemState {
  item: AccessItem | null
  enabled: boolean
}

function itemState(target: AccessTarget, key: string, world: CommandWorld): ItemState {
  if (target === 'home') {
    return { item: null, enabled: world.task.home_access }
  }
  if (target === 'host') {
    const hosts = world.access?.hosts ?? []
    return { item: null, enabled: hosts.includes(key) || hosts.includes(`${key}:${String(HTTPS_PORT)}`) }
  }
  const item = itemsOf(target, world).find((entry) => entry.id === key) ?? null
  return { item, enabled: item?.enabled ?? false }
}

function stateRefusal(op: AccessOp, state: ItemState): string | null {
  switch (op) {
    case 'on':
      return state.enabled ? 'Already on' : null
    case 'add':
      return state.enabled ? 'Already allowed' : null
    case 'off':
      return state.enabled ? null : 'Already off'
    case 'remove':
      return state.enabled ? null : "Not on this agent's own allowlist"
    case 'reset':
      return state.item?.override === null ? 'Already follows its credential or the default' : null
  }
}

const OP_VERBS: Readonly<Record<AccessOp, (what: string) => string>> = {
  on: (what) => `turns ${what} on`,
  off: (what) => `turns ${what} off`,
  reset: (what) => `resets ${what}`,
  add: (what) => `adds ${what}`,
  remove: (what) => `removes ${what}`,
}

function opRefusal(rule: OpRule, op: AccessOp, label: string, world: CommandWorld): string | null {
  if (world.author === 'user' && !rule.user) {
    return 'Only through an agent request'
  }
  return world.author === 'agent' && !rule.propose ? `Only the user ${OP_VERBS[op](label)}` : null
}

const OP_LABELS: Readonly<Record<AccessOp, string>> = {
  on: 'On',
  off: 'Off',
  reset: 'Reset',
  add: 'Add',
  remove: 'Remove',
}

/** The rule of the op on this item: a reset confirms when it turns a confirmed item back on. */
function effectiveRule(target: AccessTargetRule, op: AccessOp, state: ItemState): OpRule | null {
  const rule = target.ops[op]
  if (rule === undefined || op !== 'reset') {
    return rule ?? null
  }
  const reopens = state.item !== null && !state.item.enabled && accessBase(state.item)
  return { ...rule, confirm: (target.ops.on?.confirm ?? false) && reopens }
}

function opStep(name: AccessTarget, key: string, world: CommandWorld): GrammarStep {
  const target = ACCESS_RULES[name]
  const state = itemState(name, key, world)
  const label = name === 'aws' || name === 'home' ? target.label : `this ${target.label}`
  const ops = Object.entries(target.ops).flatMap(([op, rule]) => (isOp(op) ? [{ op, rule }] : []))
  const options = ops.map(({ op, rule }) =>
    option({
      token: op,
      label: OP_LABELS[op],
      unavailable: opRefusal(rule, op, label, world) ?? stateRefusal(op, state),
    }),
  )
  return choose(`one of ${ops.map(({ op }) => op).join(', ')}`, options)
}

function lastStep(name: AccessTarget, key: string, op: string, world: CommandWorld): GrammarStep | null {
  const rule = isOp(op) ? effectiveRule(ACCESS_RULES[name], op, itemState(name, key, world)) : null
  return rule === null ? null : { kind: 'end', rule }
}

function credentialStep(world: CommandWorld): GrammarStep {
  const options = (world.credentials ?? []).map((profile) =>
    option({
      token: /\s/.test(profile.name) ? profile.id : profile.name,
      key: profile.id,
      label: profile.name,
      current: profile.id === world.task.profile_id,
      unavailable: profile.id === world.task.profile_id ? 'This agent uses it already' : null,
    }),
  )
  return choose('a credential', options)
}

/** The step after `/seti:access` and the words that follow it, each a key the parser matched. */
export function accessStep(words: readonly string[], world: CommandWorld): GrammarStep | null {
  const [first, second, third, ...more] = words
  if (first === undefined) {
    return choose('a kind of access', targetOptions(world))
  }
  if (first === 'reset' || first === 'save') {
    return second === undefined ? { kind: 'end', rule: ACCESS_WHOLE[first].rule } : null
  }
  if (!isTarget(first) || more.length > 0) {
    return null
  }
  return targetStep(first, second, third, world)
}

function credentialTarget(
  rule: AccessTargetRule,
  second: string | undefined,
  third: string | undefined,
  world: CommandWorld,
) {
  if (second === undefined) {
    return credentialStep(world)
  }
  return third === undefined && rule.pick !== null ? ({ kind: 'end', rule: rule.pick } as const) : null
}

function singleTarget(name: AccessTarget, second: string | undefined, third: string | undefined, world: CommandWorld) {
  const key = name === 'aws' ? 'aws' : 'home'
  if (second === undefined) {
    return opStep(name, key, world)
  }
  return third === undefined ? lastStep(name, key, second, world) : null
}

function targetStep(name: AccessTarget, second: string | undefined, third: string | undefined, world: CommandWorld) {
  const rule = ACCESS_RULES[name]
  if (rule.item === 'credential') {
    return credentialTarget(rule, second, third, world)
  }
  if (rule.item === 'single') {
    return singleTarget(name, second, third, world)
  }
  if (second === undefined) {
    return name === 'host'
      ? choose('a host', hostOptions(world), hostFree)
      : choose(ITEM_PROMPTS[name] ?? 'an item', itemOptions(name, world))
  }
  return third === undefined ? opStep(name, second, world) : lastStep(name, second, third, world)
}
