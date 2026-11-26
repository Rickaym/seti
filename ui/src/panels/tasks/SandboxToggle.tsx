import type { AgentCapabilities, Task } from '@seti/shared'
import { RotateCw, Shield } from 'lucide-react'
import { useState } from 'react'
import { Hint } from '@/components/Hint'
import { ToggleButton } from '@/components/ToggleButton'
import { Button } from '@/components/ui/button'
import { useSystem } from '@/hooks/useSystem'
import { SANDBOX_HINT, SANDBOX_RESTARTS, saveSandbox } from '@/panels/tasks/setting-actions'
import { useRestartAction } from '@/panels/tasks/useSessionRestart'

/** A task's own sandbox switch; a change applies at the next turn, or now through a restart. */
function SandboxToggle({ task, running, onChanged }: { task: Task; running: boolean; onChanged: () => void }) {
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
    if ((await saveSandbox(task, sandbox, running, onChanged)) && running) {
      setTurnSandbox((prev) => prev ?? before)
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
        hint={`${task.sandbox ? SANDBOX_HINT.on : SANDBOX_HINT.off} ${SANDBOX_RESTARTS}`}
      />
      {turnSandbox !== null && turnSandbox !== task.sandbox && (
        <Button variant="outline" size="sm" onClick={() => void restart()}>
          <RotateCw />
          Restart now
        </Button>
      )}
    </span>
  )
}

/** The sandbox toggle, or a fixed Sandboxed where the agent's runtime runs only there. */
export function TaskIsolation({
  task,
  running,
  onChanged,
  caps,
}: {
  task: Task
  running: boolean
  onChanged: () => void
  caps: AgentCapabilities | null
}) {
  if (caps?.unsandboxed === false) {
    return (
      <Hint text={`${caps.label} agents run only in Seti's sandbox.`}>
        <span className="text-muted-foreground">Sandboxed</span>
      </Hint>
    )
  }
  return <SandboxToggle task={task} running={running} onChanged={onChanged} />
}
