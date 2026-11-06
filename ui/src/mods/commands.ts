import type { ModCommandContext, ModCommandWaits, ModIcon, ModUiCommand } from '@seti/mod-api'
import { modScoped, Registry, type ModActionResult, type ModCommand, type ModInfo } from '@seti/shared'
import { toast } from 'sonner'
import { apiPatch, apiPost, errorText } from '@/api'
import { isNarrow } from '@/hooks/useMedia'
import { refreshMods } from '@/hooks/useMods'
import { navigate, parseHash } from '@/lib/route'
import { modsSettled } from './synced'

/** What a mod's UI half added to one of its commands: an icon, and a run in place of the server's. */
export interface UiCommandEntry {
  /** `<mod>.<command>`. */
  key: string
  icon: ModIcon | null
  run: ModUiCommand['run'] | null
  when: ModUiCommand['when'] | null
  title: ModUiCommand['title'] | null
  /** Why its slash command waits on an agent now, when it can. */
  waits: ModCommandWaits | null
  /** What the reply box says its slash command will do. */
  status: ModUiCommand['status'] | null
}

/** Where the user is now, for a command run on `agent` or on none. */
export const commandContext = (agent: string | null): ModCommandContext => ({
  agent,
  section: parseHash().section,
  narrow: isNarrow(),
})

export const uiCommands = new Registry<UiCommandEntry>('command', (entry) => entry.key)

/** Runs a command through the mod's server half as the user; answers the line Seti shows. */
export async function callModAction(mod: string, command: string, args: Record<string, unknown>): Promise<string> {
  const answer = await apiPost<ModActionResult>(`/mods/${mod}/actions/${command}`, { args })
  return answer.text
}

/** Runs a command as the user, in the UI half when it took the run over, and shows the answer. */
export async function runModCommand(
  mod: Pick<ModInfo, 'id'>,
  command: ModCommand,
  args: Record<string, unknown>,
  { agent }: Pick<ModCommandContext, 'agent'>,
): Promise<void> {
  await modsSettled()
  const context = commandContext(agent)
  const run = uiCommands.get(modScoped(mod.id, command.id))?.run ?? null
  try {
    if (run === null) {
      toast.success(await callModAction(mod.id, command.id, args))
    } else {
      await run(args, context)
    }
  } catch (e) {
    toast.error(`${command.title} did not run`, { description: errorText(e), duration: Infinity })
  }
}

/** Turns a mod on as the user, as its switch in Settings, Mods does. */
export async function turnModOn(mod: Pick<ModInfo, 'id' | 'name'>): Promise<void> {
  try {
    await apiPatch(`/mods/${mod.id}`, { enabled: true })
    toast.success(`${mod.name} is on`)
  } catch (e) {
    toast.error(`${mod.name} did not turn on`, { description: errorText(e), duration: Infinity })
  } finally {
    refreshMods()
  }
}

/** What turning the mod on gives it, for the line under its off notice. */
export const grantsLine = (mod: Pick<ModInfo, 'capabilities'>): string | undefined =>
  mod.capabilities.length === 0 ? undefined : `Once on it may: ${mod.capabilities.join('; ')}.`

/**
 * Says the mod of a command is off, with one tap to turn it on; a security-sensitive mod opens
 * Settings, Mods instead, where the user turns it on knowingly.
 */
export function showModOff(mod: Pick<ModInfo, 'id' | 'name' | 'capabilities' | 'security_sensitive'>): void {
  toast(`${mod.name} is off`, {
    description: grantsLine(mod),
    duration: 15_000,
    action: {
      label: 'Turn on',
      onClick: () => {
        if (mod.security_sensitive) {
          navigate('settings', 'mods')
        } else {
          void turnModOn(mod)
        }
      },
    },
  })
}

/** A bundled mod that could run but is off, so its commands answer with the off notice. */
export const offBundled = (mod: ModInfo): boolean =>
  mod.tier === 'bundled' && !mod.enabled && !mod.running && mod.problem === null && mod.manifest !== null
