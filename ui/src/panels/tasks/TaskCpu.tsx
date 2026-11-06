import { cpuCapLabel, type CpuCap, type TaskCpuCap } from '@seti/shared'
import { Pencil, RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { CpuCapFields } from '@/panels/settings/CpuCapFields'
import { parseCpuForm, toCpuForm, type CpuCapForm } from '@/panels/settings/cpu-cap-form'

/** The agent's CPU cap, its own or the default, and a way to change it; applies at once. */
export function TaskCpu({ taskId }: { taskId: string }) {
  const path = `/tasks/${taskId}/cpu`
  const [state, setState] = useState<TaskCpuCap | null>(null)
  const [form, setForm] = useState<CpuCapForm | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiGet<TaskCpuCap>(path).then(setState, (e: unknown) => toast.error(errorText(e)))
  }, [path])
  if (state === null) {
    return <span className="text-muted-foreground">...</span>
  }

  const save = async (cap: CpuCap | null) => {
    setBusy(true)
    try {
      const next = await apiPut<TaskCpuCap>(path, { cap })
      setState(next)
      setForm(null)
      toast.success(`CPU cap ${cpuCapLabel(next.effective)}${next.override === null ? ', the default' : ''}`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (form === null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <span className={state.enforced ? undefined : 'text-muted-foreground'}>
          {cpuCapLabel(state.effective)} {state.override === null ? '(default)' : '(own)'}
          {!state.enforced && ', not enforced here'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label="Change CPU cap"
          onClick={() => {
            setForm(toCpuForm(state.effective))
          }}
        >
          <Pencil />
          Edit
        </Button>
      </span>
    )
  }
  const parsed = parseCpuForm(form, state.max_percent)
  return (
    <div className="space-y-2">
      <CpuCapFields
        form={form}
        maxPercent={state.max_percent}
        invalid={'error' in parsed}
        onChange={setForm}
        disabled={busy}
      />
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
