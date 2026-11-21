import type { CleanInput, CleanPlan, RemovalResult } from '@seti/shared'
import { BrushCleaning } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { refreshStorage } from '@/hooks/useStorage'
import { bytesLabel } from '@/panels/resources/format'

const MEASURE_POLL_MS = 2000

const folders = (count: number) => `${String(count)} ${count === 1 ? 'folder' : 'folders'}`

/** The plan for one agent, fetched again every few seconds while its sizes are measured. */
function usePlan(taskId: string): { plan: CleanPlan | null; error: string | null } {
  const [state, setState] = useState<{ plan: CleanPlan | null; error: string | null }>({ plan: null, error: null })
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () => {
      apiGet<CleanPlan>(`/storage/agents/${taskId}/clean`).then(
        (plan) => {
          if (live) {
            setState({ plan, error: null })
            timer = plan.measuring ? setTimeout(load, MEASURE_POLL_MS) : undefined
          }
        },
        (e: unknown) => {
          if (live) {
            setState({ plan: null, error: errorText(e) })
          }
        },
      )
    }
    load()
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [taskId])
  return state
}

function PlanBody({ plan }: { plan: CleanPlan }) {
  if (plan.refused !== null) {
    return <p className="text-muted-foreground">{plan.refused}</p>
  }
  if (plan.targets.length === 0) {
    return <p className="text-muted-foreground">Nothing rebuildable is left in this agent's folders.</p>
  }
  return (
    <>
      <p>
        Removes {folders(plan.targets.length)} a reinstall or build makes again, freeing{' '}
        <span className="font-semibold tabular-nums">{bytesLabel(plan.bytes)}</span>
        {plan.measuring ? ' so far' : ''}. Source files and anything git tracks stay.
      </p>
      <ul
        aria-label="Folders to remove"
        className="max-h-[min(20rem,45dvh)] divide-y divide-border overflow-y-auto border border-border"
      >
        {plan.targets.map((target) => (
          <li key={target.dir} className="flex items-center gap-3 px-2.5 py-1.5" title={target.dir}>
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{target.path}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {target.bytes === null ? 'Measuring' : bytesLabel(target.bytes)}
            </span>
          </li>
        ))}
      </ul>
      {plan.kept.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{folders(plan.kept.length)} stay</summary>
          <ul className="mt-1 space-y-0.5">
            {plan.kept.map((kept) => (
              <li key={kept.dir} className="truncate" title={kept.dir}>
                {kept.dir}: {kept.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  )
}

/** Shows what Clean removes from one agent and how much it frees, and removes it on confirm. */
export function CleanDialog({ taskId, title, onClose }: { taskId: string; title: string; onClose: () => void }) {
  const { plan, error } = usePlan(taskId)
  const [busy, setBusy] = useState(false)
  const ready = plan !== null && plan.refused === null && plan.targets.length > 0

  const clean = async () => {
    if (plan === null) {
      return
    }
    setBusy(true)
    try {
      const body: CleanInput = { dirs: plan.targets.map((target) => target.dir), confirm: true }
      const result = await apiPost<RemovalResult>(`/storage/agents/${taskId}/clean`, body)
      const kept = result.refused.length > 0 ? `; ${folders(result.refused.length)} stayed` : ''
      toast.success(`Freed ${bytesLabel(result.freed_bytes)} from ${title}${kept}`)
      refreshStorage()
      onClose()
    } catch (e) {
      toast.error(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Clean {title}</DialogTitle>
        </DialogHeader>
        {error !== null && <p className="text-destructive">{error}</p>}
        {plan === null && error === null && <p className="text-muted-foreground">Looking for rebuildable folders...</p>}
        {plan !== null && <PlanBody plan={plan} />}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!ready || busy} onClick={() => void clean()}>
            <BrushCleaning />
            Clean
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
