import { MOD_TASK_ARG, modScoped, type ModCommand, type ModInfo } from '@seti/shared'
import { Puzzle } from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Hint } from '@/components/Hint'
import { chordAria, chordLabel } from '@/components/shortcuts/chords'
import { Button } from '@/components/ui/button'
import { useMods } from '@/hooks/useMods'
import { commandContext, runModCommand, uiCommands } from './commands'
import { parseModChord } from './mod-chords'

/** The commands running mods put in an agent's header, by mod and command. */
const headerCommands = (mods: readonly ModInfo[]) =>
  mods.flatMap((mod) =>
    mod.running
      ? (mod.manifest?.contributes.commands ?? [])
          .filter((command) => command.for.includes('agentHeader'))
          .map((command) => ({ mod, command }))
      : [],
  )

function HeaderAction({ mod, command, agent }: { mod: ModInfo; command: ModCommand; agent: string }) {
  const ui = useSyncExternalStore(uiCommands.subscribe, () => uiCommands.get(modScoped(mod.id, command.id)))
  const context = commandContext(agent)
  if (ui?.when?.(context) === false) {
    return null
  }
  const Icon = ui?.icon ?? Puzzle
  const title = ui?.title?.(context) ?? command.title
  const chord = command.chord === undefined ? null : parseModChord(command.chord)
  return (
    <Hint text={chord === null ? title : `${title} (${chordLabel(chord)})`}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={title}
        {...(chord === null ? {} : { 'aria-keyshortcuts': chordAria(chord) })}
        onClick={() => {
          void runModCommand(mod, command, { [MOD_TASK_ARG]: agent }, { agent })
        }}
      >
        <Icon />
      </Button>
    </Hint>
  )
}

/** Icons running mods add to the desktop agent header, each run on that agent. */
export function ModHeaderActions({ agent }: { agent: string }) {
  const mods = useMods().data?.mods ?? []
  return headerCommands(mods).map(({ mod, command }) => (
    <HeaderAction key={modScoped(mod.id, command.id)} mod={mod} command={command} agent={agent} />
  ))
}
