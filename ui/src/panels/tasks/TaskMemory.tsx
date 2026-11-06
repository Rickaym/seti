import { capLabel, mbLabel, type MemoryCap, type TaskMemoryCap } from '@seti/shared'
import { Pencil, RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { MemoryCapFields } from '@/panels/settings/MemoryCapFields'
import { parseMemoryForm, toMemoryForm, type MemoryCapForm } from '@/panels/settings/memory-cap-form'

/** The agent's memory cap, its own or the default, and a way to change it; applies at once. */
export function TaskMemory({ taskId }: { taskId: string }) {
  const path = `/tasks/${taskId}/memory`
  const [state, setState] = useState<TaskMemoryCap | null>(null)
  const [form, setForm] = useState<MemoryCapForm | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiGet<TaskMemoryCap>(path).then(setState, (e: unknown) => toast.error(errorText(e)))
  }, [path])
  if (state === null) {
    return <span className="text-muted-foreground">...</span>
  }

  const save = async (cap: MemoryCap | null) => {
    setBusy(true)
    try {
      const next = await apiPut<TaskMemoryCap>(path, { cap })
      setState(next)
      setForm(null)
      toast.success(`Memory cap ${mbLabel(next.effective.max_mb)}${next.override === null ? ', the default' : ''}`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const summary = (
    <span className={state.enforced ? undefined : 'text-muted-foreground'}>
      {mbLabel(state.effective.max_mb)} {state.override === null ? '(default)' : '(own)'}
      {!state.enforced && ', not enforced here'}
    </span>
  )
  if (form === null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Hint text={capLabel(state.effective)}>{summary}</Hint>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label="Change memory cap"
          onClick={() => {
            setForm(toMemoryForm(state.effective))
          }}
        >
          <Pencil />
          Edit
        </Button>
      </span>
    )
  }
  const parsed = parseMemoryForm(form)
  return (
    <div className="space-y-2">
      <MemoryCapFields form={form} invalid={'error' in parsed} onChange={setForm} disabled={busy} />
      {'error' in parsed && <p className="text-destructive">{parsed.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || 'error' in parsed} onClick={() => 'cap' in parsed && void save(parsed.cap)}>
          <Save />
          Save
        </Button>
        {state.override !== null && (
          <Hint text="Take the default cap from Settings, Resources">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void save(null)}>
              <RotateCcw />
              Default
            </Button>
          </Hint>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setForm(null)
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
