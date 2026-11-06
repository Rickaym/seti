import { shortModHash, type ModInfo, type ModInstallInfo, type ModList } from '@seti/shared'
import { Download, RefreshCw, SkipForward, Undo2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPatch, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { refreshMods } from '@/hooks/useMods'
import { withStepUp } from '@/lib/passkeys'
import { ConsentLine } from './ConsentView'
import { allBound, pendingNote, type Bindings } from './install-state'

/** Runs a lifecycle call with a passkey step-up when asked, and says what Seti answered. */
function useRun() {
  const [busy, setBusy] = useState(false)
  const run = async (what: string, call: () => Promise<unknown>) => {
    setBusy(true)
    try {
      const result = await withStepUp(call)
      const message = (result as { message?: unknown } | null)?.message
      if (typeof message === 'string') {
        toast.success(message)
      }
    } catch (e) {
      toast.error(`Seti did not ${what}`, { description: errorText(e), duration: Infinity })
    } finally {
      setBusy(false)
      refreshMods()
    }
  }
  return { busy, run }
}

/** A waiting update: what it changes in Seti's words, the connections it needs, and the choice. */
export function PendingUpdate({ mod, install }: { mod: ModInfo; install: ModInstallInfo }) {
  const { busy, run } = useRun()
  const [bindings, setBindings] = useState<Bindings>({})
  const pending = install.pending
  if (pending === null) {
    return null
  }
  const base = `/mod-admin/mods/${mod.id}`
  return (
    <section aria-label="Pending update" className="space-y-2 border border-primary/40 bg-primary/5 p-3">
      <p className="text-sm font-medium">{pendingNote(install)}</p>
      {pending.changes.length === 0 ? (
        <p className="text-muted-foreground">It asks for nothing new.</p>
      ) : (
        <ul aria-label="What the update changes" className="list-disc space-y-0.5 pl-4">
          {pending.changes.map((change) => (
            <li key={change}>{change}</li>
          ))}
        </ul>
      )}
      {pending.bindings.length > 0 && (
        <ul className="space-y-2">
          {pending.bindings.map((line) => (
            <ConsentLine
              key={line.capability.name}
              line={line}
              bindings={bindings}
              onBind={(variable, id) => {
                setBindings((was) => ({ ...was, [variable]: id }))
              }}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={busy || !allBound(pending.bindings, bindings)}
          onClick={() =>
            void run('update the mod', async () =>
              apiPost<ModList>(`${base}/update/apply`, { hash: pending.hash, connections: bindings }),
            )
          }
        >
          <Download />
          Update now
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run('skip the update', async () => apiPost(`${base}/update/skip`, { hash: pending.hash }))
          }
        >
          <SkipForward />
          Skip
        </Button>
      </div>
    </section>
  )
}

/** How a third-party mod updates, and its kept versions to roll back to. */
export function UpdateSettings({ mod, install }: { mod: ModInfo; install: ModInstallInfo }) {
  const { busy, run } = useRun()
  const base = `/mod-admin/mods/${mod.id}`
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {install.source_kind !== 'dev' && (
          <Hint
            text={install.source_kind === 'git' ? `Check ${install.track ?? ''} for a commit` : 'Update from folder'}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void run('check for an update', async () => apiPost(`${base}/update/check`, {}))}
            >
              <RefreshCw />
              Check
            </Button>
          </Hint>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Delay (hours)</span>
          <Input
            aria-label="Update delay in hours"
            className="h-8 w-20"
            type="number"
            min={0}
            max={168}
            defaultValue={install.update_delay_hours}
            onBlur={(event) => {
              const hours = Number(event.target.value)
              if (hours !== install.update_delay_hours) {
                void run('change the delay', async () => apiPatch(base, { update_delay_hours: hours }))
              }
            }}
          />
        </div>
      </div>
      {install.versions.length === 0 ? (
        <p className="text-muted-foreground">Seti keeps no earlier version to roll back to yet.</p>
      ) : (
        <ul aria-label="Kept versions" className="border border-border bg-card">
          {install.versions.map((version) => (
            <li
              key={version.hash}
              className="flex items-center justify-between gap-2 border-b border-border px-3 py-2 last:border-b-0"
            >
              <span className="min-w-0">
                <span className="font-medium">{version.version}</span>{' '}
                <span className="text-muted-foreground">{shortModHash(version.hash)}</span>
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run('roll the mod back', async () => apiPost(`${base}/rollback`, { hash: version.hash }))
                }
              >
                <Undo2 />
                Roll back
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
