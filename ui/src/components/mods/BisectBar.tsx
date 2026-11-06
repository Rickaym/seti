import { Check, Power, PowerOff, RotateCcw, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { refreshMods, useMods } from '@/hooks/useMods'

/** While a mod bisect runs, a bar on every page asks whether the problem is still there. */
export function BisectBar() {
  const { data } = useMods()
  const [busy, setBusy] = useState(false)
  const bisect = data?.bisect ?? null
  if (bisect === null) {
    return null
  }
  const act = async (call: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await call()
    } catch (e) {
      toast.error('Seti did not change the bisect', { description: errorText(e), duration: Infinity })
    } finally {
      setBusy(false)
      refreshMods()
    }
  }
  const nameOf = (id: string) => data?.mods.find((mod) => mod.id === id)?.name ?? id
  const answer = (broken: boolean) => () => void act(async () => apiPost('/mod-admin/bisect/answer', { broken }))
  return (
    <section
      aria-label="Mod bisect"
      className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2 text-xs"
    >
      {bisect.culprit === null ? (
        <>
          <span className="min-w-0 flex-1">
            Step {bisect.step}: {bisect.suspects.length} mods left. Is the problem still there?
          </span>
          <Button size="sm" variant="outline" disabled={busy} onClick={answer(true)}>
            <X />
            Still there
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={answer(false)}>
            <Check />
            Gone
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void act(async () => apiDelete('/mod-admin/bisect'))}
          >
            <RotateCcw />
            Cancel
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1">{nameOf(bisect.culprit)} looks like the cause.</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(async () => apiPost('/mod-admin/bisect/keep'))}
          >
            <PowerOff />
            Keep it off
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act(async () => apiDelete('/mod-admin/bisect'))}
          >
            <Power />
            Turn back on
          </Button>
        </>
      )}
    </section>
  )
}
