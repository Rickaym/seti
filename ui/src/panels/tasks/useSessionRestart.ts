import type { AgentCapabilities, RestartSessionInput, Task } from '@seti/shared'
import { RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { useConfirm, type ConfirmOptions } from '@/components/ui/confirm-context'
import { useCapabilities } from '@/hooks/useCapabilities'

const ENDS = 'Background shells, processes and subagents it started end with the old process.'
const STOPS = 'It is working now, so its turn stops first.'

/** What restarting loads anew, as far as the agent's runtime loads it. */
function reloaded(caps: AgentCapabilities | null): string {
  const parts = [caps?.mcp_servers === false ? '' : 'MCP servers', caps?.plugins === false ? '' : 'plugins', 'tools']
  const named = parts.filter((part) => part !== '')
  return `${named.join(', ')} and settings`
}

/** The question before a restart, with what it ends and loads anew. */
export function restartQuestion(task: Task, running: boolean, caps: AgentCapabilities | null): ConfirmOptions {
  const effect = `${caps?.label ?? 'The runtime'} for "${task.title}" starts again with its ${reloaded(caps)} loaded anew.`
  return {
    title: 'Restart session',
    message: 'The conversation is kept.',
    detail: [effect, ENDS, running ? STOPS : ''].filter((part) => part !== '').join(' '),
    confirmLabel: running ? 'Stop and restart' : 'Restart',
    icon: RotateCw,
  }
}

/** Restarts the agent's session, stopping its turn first when `running`; false when it failed. */
export async function restartTask(task: Task, running: boolean, onChanged: () => void): Promise<boolean> {
  try {
    const body: RestartSessionInput = { interrupt: running }
    await apiPost(`/tasks/${task.id}/session/restart`, body)
    toast.success('Session restarted')
    onChanged()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

/** Restarts the agent's session after a confirmation; `running` offers to stop the turn first. */
export function useRestartAction(task: Task, running: boolean, onChanged: () => void) {
  const confirm = useConfirm()
  const caps = useCapabilities(task)
  return async () => {
    if (await confirm(restartQuestion(task, running, caps))) {
      await restartTask(task, running, onChanged)
    }
  }
}
