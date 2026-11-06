import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useCommandScope } from './command-scope'
import { commandRegistry, type PaletteCommand } from './registry'

const shownParts = (command: PaletteCommand) => [
  command.id,
  command.title,
  command.detail ?? '',
  command.group,
  command.keywords ?? '',
  command.shortcut ?? '',
]

/**
 * Offers `commands` in the palette while the calling component is mounted. `when` and `run`
 * always see the latest render, so callers need not memoize; changing a shown field re-registers.
 * Nothing registers outside the active `CommandScope`.
 */
export function useCommands(commands: readonly PaletteCommand[]): void {
  const active = useCommandScope()
  const latest = useRef(commands)
  useEffect(() => {
    latest.current = commands
  })
  const signature = JSON.stringify(commands.map(shownParts))
  useEffect(() => {
    if (!active) {
      return undefined
    }
    const current = (id: string) => latest.current.find((command) => command.id === id)
    return commandRegistry.register(
      latest.current.map((command) => ({
        ...command,
        when: (context) => current(command.id)?.when?.(context) ?? true,
        run: (context) => {
          current(command.id)?.run(context)
        },
      })),
    )
  }, [signature, active])
}

/** Every registered command, applicable or not. */
export function useRegisteredCommands(): readonly PaletteCommand[] {
  return useSyncExternalStore(commandRegistry.subscribe, commandRegistry.getSnapshot)
}
