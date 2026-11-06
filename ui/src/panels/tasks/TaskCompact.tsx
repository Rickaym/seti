import { compactLabel, type CompactRule, type TaskCompactRule } from '@seti/shared'
import { Pencil, RotateCcw, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPut, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { CompactFields } from '@/panels/settings/CompactFields'
import { parseCompactForm, toCompactForm, type CompactForm } from '@/panels/settings/compact-form'

/** The agent's compaction rule, its own or the default, and a way to change it from its next turn. */
export function TaskCompact({ taskId }: { taskId: string }) {
  const path = `/tasks/${taskId}/compact`
  const [state, setState] = useState<TaskCompactRule | null>(null)
  const [form, setForm] = useState<CompactForm | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    apiGet<TaskCompactRule>(path).then(setState, (e: unknown) => toast.error(errorText(e)))
  }, [path])
  if (state === null) {
    return <span className="text-muted-foreground">...</span>
  }

  const save = async (rule: CompactRule | null) => {
    setBusy(true)
    try {
      const next = await apiPut<TaskCompactRule>(path, { rule })
      setState(next)
      setForm(null)
      const own = next.override === null ? ', the default' : ''
      toast.success(`Compaction: ${compactLabel(next.effective)}${own}, from the next turn`)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (form === null) {
    return (
      <span className="flex flex-wrap items-center gap-2">
        <Hint text={state.effective.instructions ?? 'No compact instructions'}>
          <span>
            {compactLabel(state.effective)} {state.override === null ? '(default)' : '(own)'}
          </span>
        </Hint>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label="Change compaction"
          onClick={() => {
            setForm(toCompactForm(state.effective))
          }}
        >
          <Pencil />
          Edit
        </Button>
      </span>
    )
  }
  const parsed = parseCompactForm(form)
  return (
    <div className="space-y-2">
      <CompactFields form={form} invalid={'error' in parsed} onChange={setForm} disabled={busy} />
      {'error' in parsed && <p className="text-destructive">{parsed.error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={busy || 'error' in parsed}
          onClick={() => 'rule' in parsed && void save(parsed.rule)}
        >
          <Save />
          Save
        </Button>
        {state.override !== null && (
          <Hint text="Take the default rule from Settings, Lifecycle">
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
