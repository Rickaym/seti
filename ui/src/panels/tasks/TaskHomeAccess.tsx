import type { Task } from '@seti/shared'
import { FolderX } from 'lucide-react'
import { toast } from 'sonner'
import { apiPatch, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'

const HINT =
  'This older agent can read and write the folders in your home from its sandbox. New agents see only their own folder.'
const QUESTION =
  'This older agent can read and write the folders in your home from its sandbox. From its next turn the agent sees only its own folders: checkouts, worktrees and files elsewhere in your home are gone from its sandbox. This cannot be turned back on.'

/** An older agent's access to the user's home folders, which the user can only take away. */
export function TaskHomeAccess({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const confirm = useConfirm()
  const remove = async () => {
    const sure = await confirm({
      title: 'Remove home folders?',
      message: QUESTION,
      confirmLabel: 'Remove',
      variant: 'destructive',
    })
    if (!sure) {
      return
    }
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { home_access: false })
      toast.success('Applies from the next turn')
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Hint text={HINT}>
        <span>Writable</span>
      </Hint>
      <Hint text="Take your home folders out of this agent's sandbox, for good">
        <Button variant="outline" size="sm" onClick={() => void remove()}>
          <FolderX />
          Remove
        </Button>
      </Hint>
    </span>
  )
}
