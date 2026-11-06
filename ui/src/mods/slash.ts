import type { ModIcon } from '@seti/mod-api'
import {
  MOD_TASK_ARG,
  modScoped,
  parseComposer,
  slashTextArg,
  type ModCommand,
  type ModInfo,
  type ModList,
} from '@seti/shared'
import { useSyncExternalStore } from 'react'
import { useMods } from '@/hooks/useMods'
import { offBundled, uiCommands } from './commands'

/** A composer line that is a mod's slash command: one to run, or one whose mod is off. */
export type ModSlash =
  { kind: 'run'; mod: ModInfo; command: ModCommand; args: Record<string, unknown> } | { kind: 'off'; mod: ModInfo }

function argsOf(command: ModCommand, text: string, agent: string): Record<string, unknown> {
  const args: Record<string, unknown> = MOD_TASK_ARG in command.args ? { [MOD_TASK_ARG]: agent } : {}
  const textArg = slashTextArg(command)
  return textArg === null || text === '' ? args : { ...args, [textArg]: text }
}

/**
 * The mod slash command the line is, resolved against the mods Seti lists; null for anything
 * else, which goes on as before. A running mod's command without one to run is left to Seti.
 */
export function resolveModSlash(text: string, list: ModList | undefined, agent: string): ModSlash | null {
  const input = parseComposer(text)
  if (input.mode !== 'slash' || input.name === '') {
    return null
  }
  const name = input.name.toLowerCase()
  for (const mod of list?.mods ?? []) {
    const contributes = mod.manifest?.contributes
    const slash = contributes?.slashCommands.find((entry) => entry.name === name)
    if (slash === undefined || !(mod.running || offBundled(mod))) {
      continue
    }
    if (!mod.running) {
      return { kind: 'off', mod }
    }
    const command = contributes?.commands.find((entry) => entry.id === slash.command)
    return command === undefined ? null : { kind: 'run', mod, command, args: argsOf(command, input.args, agent) }
  }
  return null
}

const NO_WAITS = { subscribe: () => () => undefined, reason: () => null }

/** What the reply box shows for a running mod's slash command: its icon, status and wait. */
export interface ModSlashUi {
  icon: ModIcon | null
  /** What the command will do with the line, as its mod says; null to show the catalog's line. */
  status: string | null
  /** Why it waits on the agent now; null when it can run. */
  waiting: string | null
}

/** The mod slash command a reply box line is, with what its mod's UI half says about it now. */
export function useModSlash(text: string, agent: string): { slash: ModSlash | null; ui: ModSlashUi } {
  const slash = resolveModSlash(text, useMods().data, agent)
  const entries = useSyncExternalStore(uiCommands.subscribe, uiCommands.list)
  const key = slash?.kind === 'run' ? modScoped(slash.mod.id, slash.command.id) : null
  const entry = entries.find((candidate) => candidate.key === key)
  const waits = entry?.waits ?? NO_WAITS
  const waiting = useSyncExternalStore(waits.subscribe, () => waits.reason(agent))
  const status = slash?.kind === 'run' ? (entry?.status?.(slash.args) ?? null) : null
  return { slash, ui: { icon: entry?.icon ?? null, status, waiting } }
}
