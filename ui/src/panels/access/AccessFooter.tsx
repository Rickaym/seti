import type { Task, TaskAccessView } from '@seti/shared'
import { RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'

/** The access panel's footer: drop every own choice so the agent follows its credential again. */
export function AccessFooter({
  task,
  view,
  onSaved,
}: {
  task: Pick<Task, 'id' | 'title'>
  view: TaskAccessView
  onSaved: (view: TaskAccessView) => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const own = view.items.filter((item) => item.override !== null)
  const set = view.profile.name
  const reset = async () => {
    const count = own.length === 1 ? '1 own choice' : `${String(own.length)} own choices`
    const ok = await confirm({
      title: 'Reset access',
      message: `${task.title} drops its ${count} and follows ${set}, else the defaults, from its next turn.`,
      detail: own.map((item) => item.name).join(', '),
      confirmLabel: 'Reset',
      icon: RotateCcw,
    })
    if (!ok) {
      return
    }
    setBusy(true)
    try {
      onSaved(await apiPost<TaskAccessView>(`/tasks/${task.id}/access/reset`))
      toast.success(`Follows ${set} from the next turn`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="-mx-4 flex shrink-0 items-center gap-2 border-t border-border px-4 pt-2">
      <Hint text={`Drop this agent's own choices; it follows ${set}, else the defaults`}>
        <span>
          <Button
            size="sm"
            variant="ghost"
            className="pointer-coarse:h-11"
            disabled={busy || own.length === 0}
            onClick={() => void reset()}
          >
            <RotateCcw />
            Reset all
          </Button>
        </span>
      </Hint>
    </div>
  )
}
