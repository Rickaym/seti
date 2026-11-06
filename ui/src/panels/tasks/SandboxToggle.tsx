import type { Task } from '@seti/shared'
import { RotateCw, Shield } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { useSystem } from '@/hooks/useSystem'
import { useRestartAction } from '@/panels/tasks/useSessionRestart'

const SANDBOX_HINT = {
  on: 'Sandbox on: this agent sees its code, not your dotfiles, keys or Seti. Turn it off for docker or local databases.',
  off: "Sandbox off: this agent uses this machine's own access. Turn it on to run it in the sandbox.",
}

/** A task's own sandbox switch; a change applies at the next turn, or now through a restart. */
export function SandboxToggle({ task, running, onChanged }: { task: Task; running: boolean; onChanged: () => void }) {
  const settingOn = useSystem().data?.sandbox.enabled ?? false
  const restart = useRestartAction(task, running, onChanged)
  const [turnSandbox, setTurnSandbox] = useState<boolean | null>(null)
  const [wasRunning, setWasRunning] = useState(running)
  if (running !== wasRunning) {
    setWasRunning(running)
    setTurnSandbox(null)
  }
  if (!settingOn) {
    return <span className="text-muted-foreground">off in settings</span>
  }
  const save = async (sandbox: boolean) => {
    const before = task.sandbox
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { sandbox })
      toast.success(running ? 'Applies from the next turn, or restart now' : 'Applies from the next turn')
      if (running) {
        setTurnSandbox((prev) => prev ?? before)
      }
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ToggleButton
        pressed={task.sandbox}
        onPressedChange={(sandbox) => {
          void save(sandbox)
        }}
        icon={Shield}
        label="Sandbox"
        hint={`${task.sandbox ? SANDBOX_HINT.on : SANDBOX_HINT.off} Changing it restarts the session at the next turn.`}
      />
      {turnSandbox !== null && turnSandbox !== task.sandbox && (
        <Button variant="outline" size="sm" onClick={() => void restart(false)}>
          <RotateCw />
          Restart now
        </Button>
      )}
    </span>
  )
}
