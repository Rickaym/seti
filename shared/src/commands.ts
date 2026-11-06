import { z } from 'zod'
import type { CommandInfo } from './capabilities.js'
import { SHELL_PREFIX, shellIssues } from './shell.js'

/** A slash command the composer offers; `unsupported` says why it cannot run under Seti. */
export interface ComposerCommand extends CommandInfo {
  builtin: boolean
  unsupported: string | null
}

/** The menu's view of a directory's commands; descriptions are cut to one row. */
export interface CommandCatalog {
  /** The directory the list was probed in: another one when `approximate`. */
  cwd: string
  probed_at: string
  /** False while a newer list is being probed; ask again shortly for it. */
  fresh: boolean
  /** A stand-in from a nearby directory, since this one has not been probed yet. */
  approximate: boolean
  commands: ComposerCommand[]
}

export const commandScopeQuery = z.object({
  repo_id: z.uuid().optional(),
  cwd: z.string().trim().min(1).optional(),
})

export const taskParams = z.object({ id: z.string().min(1) })

/** Hints like `<file>` mark a required argument; `[file]` or `<optional ...>` do not. */
export const requiresArguments = (hint: string) => hint.trim().startsWith('<') && !/\boptional\b/i.test(hint)

const COMMAND_NAME = /^[\w.:-]+$/

export type ComposerInput =
  { mode: 'text' } | { mode: 'slash'; name: string; args: string } | { mode: 'shell'; command: string }

/** What the composer text is: a slash command, a `!` shell command or a plain message. */
export function parseComposer(text: string): ComposerInput {
  const trimmed = text.trimStart()
  if (trimmed.startsWith(SHELL_PREFIX)) {
    return { mode: 'shell', command: trimmed.slice(SHELL_PREFIX.length).trim() }
  }
  if (!trimmed.startsWith('/')) {
    return { mode: 'text' }
  }
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const name = space === -1 ? body : body.slice(0, space)
  if (name !== '' && !COMMAND_NAME.test(name)) {
    return { mode: 'text' }
  }
  return { mode: 'slash', name, args: space === -1 ? '' : body.slice(space).trim() }
}

/**
 * An agent's commands with the ones mods add, which Seti answers itself. A Seti name always
 * wins: a Claude Code or plugin command of that name is dropped and an alias of it removed, since
 * Seti never forwards it.
 */
export function withSetiCommands(
  commands: readonly ComposerCommand[],
  seti: readonly ComposerCommand[],
): ComposerCommand[] {
  const names: ReadonlySet<string> = new Set(seti.map((command) => command.name))
  const others = commands
    .filter((command) => !names.has(command.name.toLowerCase()))
    .map((command) =>
      command.aliases.some((alias) => names.has(alias.toLowerCase()))
        ? { ...command, aliases: command.aliases.filter((alias) => !names.has(alias.toLowerCase())) }
        : command,
    )
  return [...seti, ...others].sort((a, b) => a.name.localeCompare(b.name))
}

const matches = (command: ComposerCommand, name: string) => command.name === name || command.aliases.includes(name)

export function findCommand(commands: readonly ComposerCommand[], name: string): ComposerCommand | undefined {
  const lower = name.toLowerCase()
  return commands.find((command) => command.name === lower) ?? commands.find((command) => matches(command, lower))
}

const NO_MATCH = Number.POSITIVE_INFINITY

function matchScore(command: ComposerCommand, query: string): number {
  const name = command.name.toLowerCase()
  const aliases = command.aliases.map((alias) => alias.toLowerCase())
  if (name === query || aliases.includes(query)) {
    return 0
  }
  const scores: [boolean, number][] = [
    [name.startsWith(query), 1],
    [name.slice(name.indexOf(':') + 1).startsWith(query), 2],
    [aliases.some((alias) => alias.startsWith(query)), 3],
    [name.includes(query), 4],
    [query.length >= 3 && command.description.toLowerCase().includes(query), 5],
  ]
  return scores.find(([hit]) => hit)?.[1] ?? NO_MATCH
}

interface Ranked {
  command: ComposerCommand
  score: number
}

function compareRanked(a: Ranked, b: Ranked): number {
  const differences = [
    a.score - b.score,
    Number(a.command.unsupported !== null) - Number(b.command.unsupported !== null),
    a.command.name.length - b.command.name.length,
  ]
  return differences.find((difference) => difference !== 0) ?? a.command.name.localeCompare(b.command.name)
}

/** Commands matching a typed name, best first: exact, prefix, prefix after `x:`, alias, substring. */
export function rankCommands(commands: readonly ComposerCommand[], query: string, limit = 8): ComposerCommand[] {
  const q = query.trim().toLowerCase()
  return commands
    .map((command) => ({ command, score: q === '' ? Number(!command.builtin) : matchScore(command, q) }))
    .filter((entry) => entry.score !== NO_MATCH)
    .sort(compareRanked)
    .slice(0, limit)
    .map((entry) => entry.command)
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1
      current.push(Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost))
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** The supported command a mistyped name most likely meant, or null when none is close. */
export function closestCommand(commands: readonly ComposerCommand[], name: string): string | null {
  const typed = name.toLowerCase()
  if (typed === '') {
    return null
  }
  const supported = commands.filter((command) => command.unsupported === null)
  const prefixed = rankCommands(supported, typed, 1)[0]
  if (prefixed && matchScore(prefixed, typed) <= 3) {
    return prefixed.name
  }
  const limit = Math.max(2, Math.floor(typed.length / 3))
  let best: { name: string; distance: number } | null = null
  for (const command of supported) {
    for (const candidate of [command.name, ...command.aliases]) {
      const distance = editDistance(typed, candidate.toLowerCase())
      if (distance <= limit && (best === null || distance < best.distance)) {
        best = { name: command.name, distance }
      }
    }
  }
  return best?.name ?? null
}

export type ComposerCheck =
  | { kind: 'text' }
  | { kind: 'shell'; command: string; issues: string[] }
  | { kind: 'no-name' }
  | { kind: 'unchecked'; name: string }
  | { kind: 'partial'; name: string; matches: number }
  | { kind: 'unknown'; name: string; suggestion: string | null }
  | { kind: 'unsupported'; command: ComposerCommand }
  | { kind: 'needs-args'; command: ComposerCommand }
  | { kind: 'command'; command: ComposerCommand }

/** Checks composer text against the commands of its directory; null commands mean not loaded. */
export function checkComposer(text: string, commands: readonly ComposerCommand[] | null): ComposerCheck {
  const input = parseComposer(text)
  if (input.mode === 'text') {
    return { kind: 'text' }
  }
  if (input.mode === 'shell') {
    return { kind: 'shell', command: input.command, issues: shellIssues(input.command) }
  }
  if (input.name === '') {
    return { kind: 'no-name' }
  }
  if (commands === null) {
    return { kind: 'unchecked', name: input.name }
  }
  const command = findCommand(commands, input.name)
  if (!command) {
    const count = input.args === '' ? rankCommands(commands, input.name, commands.length).length : 0
    return count > 0
      ? { kind: 'partial', name: input.name, matches: count }
      : { kind: 'unknown', name: input.name, suggestion: closestCommand(commands, input.name) }
  }
  if (command.unsupported !== null) {
    return { kind: 'unsupported', command }
  }
  return requiresArguments(command.argument_hint) && input.args === ''
    ? { kind: 'needs-args', command }
    : { kind: 'command', command }
}

/** The question to ask before sending, or null when the text can go as it is. */
export function confirmationFor(check: ComposerCheck): string | null {
  switch (check.kind) {
    case 'unknown':
    case 'partial':
      return `/${check.name} is not available to this agent. Send it anyway?`
    case 'unsupported':
      return `/${check.command.name} is not supported in Seti: ${check.command.unsupported ?? ''}. Send it anyway?`
    case 'shell':
      return check.issues.length === 0 ? null : `${check.issues.join('. ')}. Run it anyway?`
    case 'text':
    case 'no-name':
    case 'unchecked':
    case 'needs-args':
    case 'command':
      return null
  }
}
