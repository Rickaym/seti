import os from 'node:os'
import { withSetiCommands, type CommandCatalog, type CommandInfo, type ComposerCommand } from '@seti/shared'
import type { CapabilityLookup } from './capabilities.js'
import { mainCheckout } from './git.js'
import { setiCommands } from './mods/points.js'

const TERMINAL_ONLY = 'it only changes the terminal display'
const TERMINAL_UI = 'Claude Code marks it as terminal only'

/** Builtins the SDK lists that cannot do anything useful in a Seti turn, with the reason shown. */
const UNSUPPORTED: Record<string, string> = {
  clear: 'Seti keeps one session per agent, so start a new agent instead',
  color: TERMINAL_ONLY,
  doctor: TERMINAL_UI,
  focus: TERMINAL_ONLY,
  heapdump: 'it debugs the Claude Code process, not the agent',
  loop: 'it needs a session that stays open between turns',
  'reload-plugins': TERMINAL_UI,
}

/** Internal entry points the CLI lists but never meant for people to type. */
const isInternal = (name: string) => name.startsWith('_') || name === 'workflow-launch-exec'

/** Menu rows show one line, so longer descriptions are cut; Capabilities keeps the full text. */
export const MENU_DESCRIPTION_LIMIT = 120

export function menuDescription(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= MENU_DESCRIPTION_LIMIT) {
    return line
  }
  const cut = line.slice(0, MENU_DESCRIPTION_LIMIT - 3)
  const space = cut.lastIndexOf(' ')
  return `${(space > MENU_DESCRIPTION_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd().replace(/[,;:.-]$/, '')}...`
}

const toComposer = (command: CommandInfo, builtin: boolean): ComposerCommand => ({
  name: command.name,
  description: menuDescription(command.description),
  argument_hint: command.argument_hint,
  aliases: command.aliases,
  builtin,
  unsupported: builtin ? (UNSUPPORTED[command.name] ?? null) : null,
})

/**
 * Every slash command a task directory offers, builtins first where names repeat. An agent's
 * catalog adds Seti's own commands, which win over any of the same name.
 */
export function commandCatalog(
  { snapshot, exact, fresh }: CapabilityLookup,
  { agent = false }: { agent?: boolean } = {},
): CommandCatalog {
  const builtin = snapshot.builtin_commands.map((command) => toComposer(command, true))
  const taken = new Set(builtin.map((command) => command.name))
  const others = snapshot.skill_groups
    .flatMap((group) => group.commands)
    .filter((command) => !taken.has(command.name))
    .map((command) => toComposer(command, false))
  const commands = [...builtin, ...others].filter((command) => !isInternal(command.name))
  return {
    cwd: snapshot.cwd,
    probed_at: snapshot.probed_at,
    fresh,
    approximate: !exact,
    commands: agent
      ? withSetiCommands(commands, setiCommands())
      : commands.toSorted((a, b) => a.name.localeCompare(b.name)),
  }
}

const checkouts = new Map<string, Promise<string | null>>()

/** Directories whose commands best stand in for an unprobed one: its main checkout, then home. */
export async function nearbyDirs(cwd: string): Promise<string[]> {
  let main = checkouts.get(cwd)
  if (main === undefined) {
    main = mainCheckout(cwd)
    checkouts.set(cwd, main)
  }
  return [await main, os.homedir()].filter((dir): dir is string => dir !== null && dir !== cwd)
}
