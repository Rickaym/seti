import type { BypassHours, BypassState, Task } from '@seti/shared'
import { toast } from 'sonner'
import { apiPatch, apiPut, errorText } from '@/api'

export const BYPASS_DETAIL =
  "Runs every tool without asking for the hours you pick, then turns off by itself. Ask rules still ask; deny rules, Seti's guards and the sandbox still apply."

export const SANDBOX_HINT = {
  on: 'Sandbox on: this agent sees its code, not your dotfiles, keys or Seti. Turn it off for docker or local databases.',
  off: "Sandbox off: this agent uses this machine's own access. Turn it on to run it in the sandbox.",
}

export const SANDBOX_RESTARTS = 'Changing it restarts the session at the next turn.'

/** Turns the agent's sandbox on or off from its next turn; false when the change failed. */
export async function saveSandbox(task: Task, sandbox: boolean, running: boolean, onChanged: () => void) {
  try {
    await apiPatch<Task>(`/tasks/${task.id}`, { sandbox })
    toast.success(running ? 'Applies from the next turn, or restart now' : 'Applies from the next turn')
    onChanged()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}

/** Turns Bypass on for `hours`, or off with null; false when the change failed. */
export async function saveBypass(task: Task, hours: BypassHours | null, onChanged: () => void) {
  try {
    const state = await apiPut<BypassState>(`/tasks/${task.id}/permissions/bypass`, { hours })
    if (state.applied === 'next_turn') {
      toast.success('Applies from the next turn')
    }
    onChanged()
    return true
  } catch (e) {
    toast.error(errorText(e))
    return false
  }
}
