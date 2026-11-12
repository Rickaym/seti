import type { Task } from '@seti/shared'
import { FolderOpen, OctagonX, Pencil, Pin, PinOff, Search, SquareTerminal } from 'lucide-react'
import type { ComponentType } from 'react'
import { FIND_SHORTCUT } from '@/components/shortcuts/find'
import { processesLabel } from '@/panels/processes/useAgentProcesses'

export interface AgentAction {
  label: string
  icon: ComponentType<{ className?: string }>
  /** Shown at the row's end, such as how many processes run. */
  detail?: string
  /** Its key shortcut, shown in menus but not on the phone's sheet. */
  shortcut?: string
  /** The row's accessible name when it should say more than the label. */
  ariaLabel?: string
  onSelect: () => void
}

export interface ActionHandlers {
  find: () => void
  files: () => void
  processes: () => void
  /** Opens or closes the agent's Questions drawer. */
  questions: () => void
  pin: (pinned: boolean) => void
  rename: () => void
  /** Stops the turn or shell command. */
  stop: () => void
  endBackground: () => void
}

/** What runs now: a turn or shell command, background jobs and processes. */
export interface Running {
  busy: boolean
  background: number
  processes: number
}

/**
 * The actions the desktop header shows as icons, as labeled rows for phones and frames, after
 * the rows mods add.
 */
export function agentActions(
  task: Task,
  { processes: running, background }: Running,
  on: ActionHandlers,
  mods: readonly AgentAction[],
): AgentAction[] {
  const processes: AgentAction = {
    label: 'Processes',
    icon: SquareTerminal,
    ariaLabel: processesLabel(running),
    onSelect: on.processes,
  }
  if (running > 0) {
    processes.detail = `${String(running)} running`
  }
  const actions: AgentAction[] = [
    ...mods,
    { label: 'Find in this chat', icon: Search, shortcut: FIND_SHORTCUT, onSelect: on.find },
    { label: 'Files', icon: FolderOpen, onSelect: on.files },
    processes,
    {
      label: task.pinned ? 'Unpin' : 'Pin',
      icon: task.pinned ? PinOff : Pin,
      onSelect: () => {
        on.pin(!task.pinned)
      },
    },
    { label: 'Rename', icon: Pencil, onSelect: on.rename },
  ]
  if (background > 0) {
    actions.push({ label: 'Stop background work', icon: OctagonX, onSelect: on.endBackground })
  }
  return actions
}
