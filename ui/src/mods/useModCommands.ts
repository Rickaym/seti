import { MOD_TASK_ARG, modScoped, type ModCommand, type ModInfo, type ModList } from '@seti/shared'
import { Puzzle } from 'lucide-react'
import { useMemo, useSyncExternalStore } from 'react'
import type { PaletteCommand } from '@/components/palette/registry'
import { useCommands } from '@/components/palette/useCommands'
import { chordLabel } from '@/components/shortcuts/chords'
import { useMods } from '@/hooks/useMods'
import type { AgentAction } from '@/panels/tasks/agent-actions'
import { commandContext, offBundled, runModCommand, showModOff, uiCommands, type UiCommandEntry } from './commands'
import { parseModChord } from './mod-chords'

const takesTask = (command: ModCommand) => MOD_TASK_ARG in command.args

/** The slash command that runs the command, as `/name`, which menus show as its shortcut. */
function slashOf(mod: ModInfo, command: ModCommand): string | undefined {
  const slash = mod.manifest?.contributes.slashCommands.find((entry) => entry.command === command.id)
  return slash === undefined ? undefined : `/${slash.name}`
}

function paletteCommand(mod: ModInfo, command: ModCommand, ui: UiCommandEntry | undefined): PaletteCommand {
  const onAgent = takesTask(command)
  const entry: PaletteCommand = {
    id: `mod.${modScoped(mod.id, command.id)}`,
    title: command.title,
    detail: mod.running ? mod.name : `${mod.name} is off`,
    icon: ui?.icon ?? Puzzle,
    group: onAgent ? 'Current agent' : 'General',
    keywords: [mod.name, command.description ?? '', slashOf(mod, command) ?? ''].join(' '),
    run: ({ agent }) => {
      if (!mod.running) {
        showModOff(mod)
        return
      }
      const args = onAgent && agent !== null ? { [MOD_TASK_ARG]: agent.id } : {}
      void runModCommand(mod, command, args, { agent: agent?.id ?? null })
    },
  }
  const base = onAgent ? { ...entry, when: ({ agent }: { agent: { id: string } | null }) => agent !== null } : entry
  return mod.running ? withUi(base, mod, command, ui) : base
}

/** The key a running mod's palette entry shows: its chord, else the slash command that runs it. */
function shortcutOf(mod: ModInfo, command: ModCommand): string | undefined {
  return command.chord === undefined ? slashOf(mod, command) : chordLabel(parseModChord(command.chord))
}

/** Adds the shortcut, and the UI half's `when` and `title`, to a running mod's palette entry. */
function withUi(entry: PaletteCommand, mod: ModInfo, command: ModCommand, ui: UiCommandEntry | undefined) {
  const key = shortcutOf(mod, command)
  const shortcut = key === undefined ? {} : { shortcut: key }
  const { when, title } = ui ?? {}
  const asked = entry.when
  const context = (agent: { id: string } | null) => commandContext(agent?.id ?? null)
  const placed: PaletteCommand = {
    ...entry,
    ...shortcut,
    ...(when === null || when === undefined ? {} : { when: (at) => (asked?.(at) ?? true) && when(context(at.agent)) }),
    ...(title === null || title === undefined ? {} : { titleFor: (at) => title(context(at.agent)) }),
  }
  return placed
}

const commandsFor = (list: ModList | undefined, where: ModCommand['for'][number], off: boolean) =>
  (list?.mods ?? [])
    .filter((mod) => mod.running || (off && offBundled(mod)))
    .flatMap((mod) =>
      (mod.manifest?.contributes.commands ?? [])
        .filter((command) => command.for.includes(where))
        .map((command) => ({ mod, command })),
    )

/** The palette commands of mods: those of running mods, and of bundled mods that are off. */
export function modPaletteCommands(list: ModList | undefined, ui: readonly UiCommandEntry[]): PaletteCommand[] {
  const byKey = new Map(ui.map((entry) => [entry.key, entry]))
  return commandsFor(list, 'palette', true).map(({ mod, command }) =>
    paletteCommand(mod, command, byKey.get(modScoped(mod.id, command.id))),
  )
}

/** Offers mods' commands in the palette while the app runs. */
export function useModPaletteCommands(list: ModList | undefined): void {
  const ui = useSyncExternalStore(uiCommands.subscribe, uiCommands.list)
  const commands = useMemo(() => modPaletteCommands(list, ui), [list, ui])
  useCommands(commands)
}

/** The rows running mods add to an agent's More actions menu, each run on that agent. */
export function modAgentActions(list: ModList | undefined, ui: readonly UiCommandEntry[], agent: string) {
  const byKey = new Map(ui.map((entry) => [entry.key, entry]))
  return commandsFor(list, 'agentMenu', false).map(({ mod, command }): AgentAction => {
    const row: AgentAction = {
      label: command.title,
      icon: byKey.get(modScoped(mod.id, command.id))?.icon ?? Puzzle,
      onSelect: () => {
        void runModCommand(mod, command, { [MOD_TASK_ARG]: agent }, { agent })
      },
    }
    const detail = slashOf(mod, command)
    return detail === undefined ? row : { ...row, detail }
  })
}

/** The rows running mods add to the agent's More actions menu. */
export function useModAgentActions(agent: string): AgentAction[] {
  const list = useMods().data
  const ui = useSyncExternalStore(uiCommands.subscribe, uiCommands.list)
  return useMemo(() => modAgentActions(list, ui, agent), [list, ui, agent])
}
