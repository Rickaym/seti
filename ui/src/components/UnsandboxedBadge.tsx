import type { Task } from '@seti/shared'
import { ShieldOff } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { useSandboxed } from '@/hooks/useSandboxed'

/** Marks a task whose commands run with full access to the machine and the network. */
export function UnsandboxedBadge({ task }: { task: Pick<Task, 'sandbox'> }) {
  if (useSandboxed(task)) {
    return null
  }
  const why = task.sandbox ? 'Unsandboxed: the sandbox is off in settings' : 'Unsandboxed: started without the sandbox'
  return (
    <Hint text={why}>
      <span role="img" aria-label={why} className="flex shrink-0 items-center text-warning-text">
        <ShieldOff className="size-3" aria-hidden />
      </span>
    </Hint>
  )
}
