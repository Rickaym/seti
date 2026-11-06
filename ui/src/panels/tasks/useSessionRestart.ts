import type { RestartSessionInput, Task } from '@seti/shared'
import { Eraser, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useCommands } from '@/components/palette/useCommands'
import { useConfirm, type ConfirmOptions } from '@/components/ui/confirm-context'

const ENDS = 'Background shells, processes and subagents it started end with the old process.'
const STOPS = 'It is working now, so its turn stops first.'
/** Confirm labels for an idle agent and for one whose turn stops first. */
const LABELS = { restart: ['Restart', 'Stop and restart'], fresh: ['Start fresh', 'Stop and start fresh'] } as const

function question(task: Task, fresh: boolean, running: boolean): ConfirmOptions {
  const effect = fresh
    ? `"${task.title}" starts a new Claude Code session. The transcript stays here, and its task.md and workspace still describe the task.`
    : `Claude Code for "${task.title}" starts again with its MCP servers, plugins, tools and settings loaded anew.`
  return {
    title: fresh ? 'Start fresh session' : 'Restart session',
    message: fresh ? 'The agent forgets this conversation.' : 'The conversation is kept.',
    detail: [effect, ENDS, running ? STOPS : ''].filter((part) => part !== '').join(' '),
    confirmLabel: LABELS[fresh ? 'fresh' : 'restart'][running ? 1 : 0],
    variant: fresh ? 'destructive' : 'default',
    icon: fresh ? Eraser : RotateCw,
  }
}

/** Restarts the agent's session, or starts it fresh, after a confirmation. */
export function useRestartAction(task: Task, running: boolean, onChanged: () => void) {
  const confirm = useConfirm()
  return async (fresh: boolean) => {
    if (!(await confirm(question(task, fresh, running)))) {
      return
    }
    try {
      const body: RestartSessionInput = { interrupt: running, fresh }
      await apiPost(`/tasks/${task.id}/session/restart`, body)
      toast.success(fresh ? 'Fresh session started' : 'Session restarted')
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
}

/**
 * Restarting the agent's session, which keeps the conversation, or starting it fresh without it,
 * after a confirmation; both are in the palette too. `running` offers to stop the turn first.
 */
export function useSessionRestart(task: Task, running: boolean, onChanged: () => void) {
  const restart = useRestartAction(task, running, onChanged)
  useCommands([
    {
      id: 'agent.restart-session',
      title: 'Restart session',
      detail: task.title,
      icon: RotateCw,
      group: 'Current agent',
      keywords: 'reload reconnect mcp servers plugins tools claude code process',
      when: (context) => context.agent?.id === task.id,
      run: () => void restart(false),
    },
    {
      id: 'agent.fresh-session',
      title: 'Start fresh session',
      detail: task.title,
      icon: Eraser,
      group: 'Current agent',
      keywords: 'new clear forget reset context conversation',
      when: (context) => context.agent?.id === task.id,
      run: () => void restart(true),
    },
  ])
  return {
    restart: async () => restart(false),
    fresh: async () => restart(true),
  }
}
