import type { AccessSavePreview, Task, TaskAccessView } from '@seti/shared'
import { RotateCcw, Upload } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { SaveAccessDialog } from './SaveAccessDialog'

/**
 * The access panel's footer: drop every own choice so the agent follows its credential again, or
 * save the agent's access into its credential, after a preview, for every agent using it.
 */
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
  const [preview, setPreview] = useState<AccessSavePreview | null>(null)
  const base = `/credentials/profiles/${view.profile.id}/access`
  const look = async () => {
    try {
      setPreview(await apiPost<AccessSavePreview>(`${base}/preview`, { task_id: task.id }))
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  const save = async (fingerprint: string) => {
    setBusy(true)
    try {
      await apiPost(`${base}/save`, { task_id: task.id, expect: fingerprint })
      setPreview(null)
      onSaved(await apiGet<TaskAccessView>(`/tasks/${task.id}/access`))
      toast.success(`Saved to ${view.profile.name}; its agents follow it from their next turn`)
    } catch (e) {
      toast.error(errorText(e))
      void look()
    } finally {
      setBusy(false)
    }
  }
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
      <Hint
        text={
          view.sandboxed
            ? `Copy this agent's access into ${set}; agents using it follow it`
            : 'Credentials apply to sandboxed agents only'
        }
      >
        <span className="ml-auto">
          <Button
            size="sm"
            variant="outline"
            className="pointer-coarse:h-11"
            disabled={busy || !view.sandboxed}
            onClick={() => void look()}
          >
            <Upload />
            Save access
          </Button>
        </span>
      </Hint>
      {preview !== null && (
        <SaveAccessDialog
          title={task.title}
          preview={preview}
          busy={busy}
          onSave={() => void save(preview.fingerprint)}
          onClose={() => {
            setPreview(null)
          }}
        />
      )}
    </div>
  )
}
