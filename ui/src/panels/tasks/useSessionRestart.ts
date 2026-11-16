import type { RestartSessionInput, Task } from '@seti/shared'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useCommands } from '@/components/palette/useCommands'
import { useConfirm, type ConfirmOptions } from '@/components/ui/confirm-context'

const ENDS = 'Background shells, processes and subagents it started end with the old process.'
const STOPS = 'It is working now, so its turn stops first.'

function question(task: Task, running: boolean): ConfirmOptions {
  const effect = `Claude Code for "${task.title}" starts again with its MCP servers, plugins, tools and settings loaded anew.`
  return {
    title: 'Restart session',
    message: 'The conversation is kept.',
    detail: [effect, ENDS, running ? STOPS : ''].filter((part) => part !== '').join(' '),
    confirmLabel: running ? 'Stop and restart' : 'Restart',
    icon: RotateCw,
  }
}

/** Restarts the agent's session after a confirmation; `running` offers to stop the turn first. */
export function useRestartAction(task: Task, running: boolean, onChanged: () => void) {
  const confirm = useConfirm()
  return async () => {
    if (!(await confirm(question(task, running)))) {
      return
    }
    try {
      const body: RestartSessionInput = { interrupt: running }
      await apiPost(`/tasks/${task.id}/session/restart`, body)
      toast.success('Session restarted')
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
}

/** Restarting the agent's session, which keeps the conversation; it is in the palette too. */
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
      run: () => void restart(),
    },
  ])
  return restart
}
