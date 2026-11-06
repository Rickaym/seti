import { MOD_TASK_ARG, modScoped, type Disposer, type ModCommand, type ModManifest } from '@seti/shared'
import { parseHash } from '@/lib/route'
import { commandContext, runModCommand, uiCommands } from './commands'
import { parseModChord, registerModChord } from './mod-chords'

/** The agent the page shows, which a chord's command acts on; null elsewhere. */
function shownAgent(): string | null {
  const route = parseHash()
  return route.section === 'agents' && route.terminal === null && route.id !== 'new' ? route.id : null
}

/** Runs the command its chord names, where its `when` allows and it has the agent it needs. */
function runByChord(manifest: ModManifest, command: ModCommand): void {
  const agent = shownAgent()
  const context = commandContext(agent)
  if (uiCommands.get(modScoped(manifest.id, command.id))?.when?.(context) === false) {
    return
  }
  const task = command.args[MOD_TASK_ARG]
  if (task !== undefined && !task.optional && agent === null) {
    return
  }
  const args = task !== undefined && agent !== null ? { [MOD_TASK_ARG]: agent } : {}
  void runModCommand(manifest, command, args, { agent })
}

/** Binds the chords the manifest gives its commands; one Seti or another mod binds stops it. */
export function registerCommandChords(manifest: ModManifest, track: (dispose: Disposer) => Disposer): void {
  for (const command of manifest.contributes.commands) {
    if (command.chord !== undefined) {
      track(
        registerModChord({
          key: modScoped(manifest.id, command.id),
          chord: parseModChord(command.chord),
          owner: manifest.name,
          run: () => {
            runByChord(manifest, command)
          },
        }),
      )
    }
  }
}
