import type { Task } from '@seti/shared'
import { TerminalSquare } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { useTasks } from '@/hooks/useTasks'

/** Whether the listed agents run on more than one runtime, the only time a badge tells them apart. */
function useMixedRuntimes(): boolean {
  const { tasks } = useTasks()
  return tasks.some((task) => task.runtime !== tasks[0]?.runtime)
}

/** A quiet mark on a Codex agent while agents run on more than one runtime. */
export function RuntimeBadge({ task }: { task: Pick<Task, 'runtime' | 'requested_model'> }) {
  const mixed = useMixedRuntimes()
  if (task.runtime !== 'codex' || !mixed) {
    return null
  }
  const name = task.requested_model === null ? 'Codex' : `Codex, ${task.requested_model}`
  return (
    <Hint text={name}>
      <span role="img" aria-label={name} className="flex shrink-0 items-center text-muted-foreground">
        <TerminalSquare className="size-3" aria-hidden />
      </span>
    </Hint>
  )
}
