import { coresLabel } from '../cpu.js'
import { mbLabel } from '../memory.js'
import { setiName, type SetiName } from './names.js'
import { ACCESS_RULES, ACCESS_TARGETS, ACCESS_WHOLE, type AccessTarget } from './rules.js'
import type { CommandWorld } from './world.js'

const isTarget = (word: string): word is AccessTarget => (ACCESS_TARGETS as readonly string[]).includes(word)

function itemName(target: AccessTarget, key: string, world: CommandWorld): string {
  if (target === 'credential') {
    return world.credentials?.find((profile) => profile.id === key)?.name ?? key
  }
  return world.access?.items.find((item) => item.id === key)?.name ?? key
}

function describeAccess(words: readonly string[], world: CommandWorld): string {
  const [first = ''] = words
  if (first === 'reset' || first === 'save') {
    return ACCESS_WHOLE[first].description
  }
  return isTarget(first) ? describeTarget(first, words[1] ?? '', words[2] ?? '', world) : first
}

function describeTarget(first: AccessTarget, key: string, op: string, world: CommandWorld): string {
  const { label } = ACCESS_RULES[first]
  switch (first) {
    case 'aws':
      return `Turn AWS ${key} for this agent`
    case 'home':
      return "Take your home folders out of this agent's sandbox for good"
    case 'credential':
      return `Switch this agent to the credential ${itemName(first, key, world)}`
    case 'host':
      return op === 'add' ? `Let this agent reach ${key}` : `Stop this agent reaching ${key}`
    case 'ssh':
    case 'mcp':
    case 'plugin':
    case 'pack':
      return describeItem(`the ${label} ${itemName(first, key, world)}`, op)
  }
}

const describeItem = (what: string, op: string) =>
  op === 'reset' ? `Set ${what} back to its credential or the default` : `Turn ${what} ${op} for this agent`

function describeAmount(name: string, key: string): string {
  const what = name === 'memory' ? 'memory cap' : 'CPU cap'
  if (key === 'default') {
    return `Set this agent's ${what} back to the default`
  }
  if (key === 'none') {
    return "Take this agent's CPU cap off"
  }
  const size = name === 'memory' ? mbLabel(Number(key)) : coresLabel(Number(key))
  return `Set this agent's ${what} to ${size}`
}

const workspaceName = (id: string, world: CommandWorld) =>
  world.workspaces?.find((workspace) => workspace.id === id)?.name ?? id

function describeValue(found: SetiName, value: string, world: CommandWorld): string {
  const { grammar, entry } = found
  switch (grammar.kind) {
    case 'text':
      return `${entry.label}: ${value}`
    case 'workspace':
      return `Move this agent to ${workspaceName(value, world)}`
    case 'open':
      return value === '' ? `Open ${entry.label}` : `Open ${entry.label}: ${value}`
    case 'values':
      return value === 'on' || value === 'off'
        ? `Turn ${entry.label} ${value}`
        : `${entry.label}: ${grammar.values.find((choice) => choice.value === value)?.label ?? value}`
    case 'amount':
      return describeAmount(found.name, value)
    case 'access':
    case 'alias':
    case 'run':
    case 'within':
      return entry.label
  }
}

/** What a parsed command does, in Seti's own words, for the confirm line, the card and the audit. */
export function describeSetiCommand(keys: readonly string[], world: CommandWorld): string {
  const [name = '', ...rest] = keys
  const found = setiName(name)
  if (found === undefined) {
    return name
  }
  if (found.grammar.kind === 'access') {
    return describeAccess(rest, world)
  }
  if (found.grammar.kind === 'alias') {
    return describeAccess([found.grammar.target, ...rest], world)
  }
  return describeValue(found, rest[0] ?? '', world)
}
