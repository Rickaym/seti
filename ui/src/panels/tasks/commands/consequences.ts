import type { AgentCapabilities, SetiCommand, Task } from '@seti/shared'
import { Check, FastForward, Globe, KeyRound, ShieldOff, Terminal, type LucideIcon } from 'lucide-react'
import type { ConfirmOptions } from '@/components/ui/confirm-context'
import { BYPASS_DETAIL, SANDBOX_HINT, SANDBOX_RESTARTS } from '@/panels/tasks/setting-actions'
import { archiveQuestion } from '@/panels/tasks/useArchive'
import { restartQuestion } from '@/panels/tasks/useSessionRestart'

const NEXT_TURN = 'Applies from its next turn.'

/** What a confirmed access change does, by its kind, beside Seti's description of it. */
const ACCESS_CONSEQUENCES: Readonly<Record<string, [string, LucideIcon, boolean]>> = {
  ssh: ['It can open a shell on this host with your key.', Terminal, false],
  aws: ["Its AWS calls run as the credential's role.", KeyRound, false],
  host: ["Its sandbox's proxy lets its requests to this host through.", Globe, false],
  home: ['Your home folders leave its sandbox for good; this cannot be undone.', ShieldOff, true],
  reset: ['Its own choices go; it follows its credential and the defaults again.', Check, false],
}

function accessQuestion(command: SetiCommand): ConfirmOptions {
  const kind = command.keys[0] === 'mcp' ? 'mcp' : (command.keys[1] ?? '')
  const [message, icon, destructive] = ACCESS_CONSEQUENCES[kind] ?? [NEXT_TURN, Check, false]
  return {
    title: command.description,
    message,
    detail: NEXT_TURN,
    confirmLabel: destructive ? 'Remove' : 'Allow',
    variant: destructive ? 'destructive' : 'default',
    icon,
  }
}

/** The settings' own question before a Seti command that asks to be confirmed. */
export function questionFor(
  command: SetiCommand,
  task: Task,
  running: boolean,
  caps: AgentCapabilities | null,
): ConfirmOptions {
  const [name = '', value = ''] = command.keys
  switch (name) {
    case 'sandbox':
      return {
        title: 'Turn the sandbox off',
        message: SANDBOX_HINT.off,
        detail: SANDBOX_RESTARTS,
        confirmLabel: 'Turn off',
        variant: 'destructive',
        icon: ShieldOff,
      }
    case 'bypass':
      return {
        title: 'Turn Bypass on',
        message: `"${task.title}" runs every tool without asking for ${value} hours.`,
        detail: BYPASS_DETAIL,
        confirmLabel: 'Turn on',
        icon: FastForward,
      }
    case 'restart':
      return restartQuestion(task, running, caps)
    case 'archive':
      return archiveQuestion(task)
    case 'access':
    case 'mcp':
      return accessQuestion(command)
    case 'control':
      return {
        title: command.description,
        message:
          value === 'full'
            ? "Its Seti tools reach every agent and Seti's own settings, except security settings."
            : 'Its Seti tools act on itself.',
        detail: NEXT_TURN,
        confirmLabel: 'Raise',
      }
    default:
      return { title: command.description, message: NEXT_TURN, confirmLabel: 'Confirm' }
  }
}
