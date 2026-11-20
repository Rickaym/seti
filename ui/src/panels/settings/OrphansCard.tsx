import type { Orphan, RemovalResult, RemoveOrphansInput } from '@seti/shared'
import { Copy, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useConfirm } from '@/components/ui/confirm-context'
import { refreshStorage } from '@/hooks/useStorage'
import { bytesLabel, sizeLabel } from '@/panels/resources/format'
import { SettingRow, SettingsCard } from './layout'

const items = (count: number) => `${String(count)} ${count === 1 ? 'orphan' : 'orphans'}`

const copyPath = (dir: string) => {
  navigator.clipboard.writeText(dir).then(
    () => toast.success('Path copied'),
    () => toast.error('Copy failed'),
  )
}

function OrphanRow({ orphan, picked, onToggle }: { orphan: Orphan; picked: boolean; onToggle: (on: boolean) => void }) {
  const what = orphan.kind === 'worktree_record' ? `a worktree record of ${orphan.where}` : `in ${orphan.where}`
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-2">
      <Checkbox
        aria-label={`Remove ${orphan.path}`}
        checked={picked}
        disabled={orphan.kept !== null}
        onCheckedChange={(on) => {
          onToggle(on === true)
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono" title={orphan.path}>
          {orphan.path}
        </div>
        <div className="truncate text-2xs text-muted-foreground" title={orphan.kept ?? undefined}>
          {orphan.kept === null ? what : `Stays: ${orphan.kept}`}
        </div>
      </div>
      {orphan.kind === 'folder' && <span className="shrink-0 tabular-nums">{sizeLabel(orphan.size)}</span>}
      {orphan.kept !== null && (
        <Hint text="Copy the path to open it in a terminal">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy path of ${orphan.path}`}
            onClick={() => {
              copyPath(orphan.path)
            }}
          >
            <Copy />
          </Button>
        </Hint>
      )}
    </li>
  )
}

/** Folders no agent owns and worktree records whose folder is gone; work git has not saved stays. */
export function OrphansCard({ orphans }: { orphans: readonly Orphan[] }) {
  const confirm = useConfirm()
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const chosen = orphans.filter((orphan) => orphan.kept === null && picked.has(orphan.path))
  const bytes = chosen.reduce((sum, orphan) => sum + (orphan.size?.bytes ?? 0), 0)
  const removable = orphans.filter((orphan) => orphan.kept === null)

  const remove = async () => {
    const message = `Remove ${items(chosen.length)}, ${bytesLabel(bytes)}, for good?`
    const detail = 'Folders that hold uncommitted changes or unpushed commits are never removed.'
    if (
      !(await confirm({ title: 'Remove orphans', message, detail, confirmLabel: 'Remove', variant: 'destructive' }))
    ) {
      return
    }
    setBusy(true)
    try {
      const body: RemoveOrphansInput = { paths: chosen.map((orphan) => orphan.path), confirm: true }
      const result = await apiPost<RemovalResult>('/storage/orphans/remove', body)
      const kept = result.refused.length > 0 ? `; ${items(result.refused.length)} stayed` : ''
      toast.success(`Removed ${items(result.removed.length)}, freed ${bytesLabel(result.freed_bytes)}${kept}`)
      setPicked(new Set())
      refreshStorage()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title="Orphans"
      actions={
        <Button variant="destructive" size="sm" disabled={busy || chosen.length === 0} onClick={() => void remove()}>
          <Trash2 />
          Remove {String(chosen.length)}
        </Button>
      }
    >
      <SettingRow
        label="No agent owns these"
        stack
        description="Folders of deleted agents and failed starts in Seti's folders, and worktree records whose folder is gone. A folder with uncommitted changes or unpushed commits stays."
      >
        <Button
          variant="outline"
          size="sm"
          disabled={removable.length === 0}
          onClick={() => {
            setPicked(new Set(removable.map((orphan) => orphan.path)))
          }}
        >
          Select all
        </Button>
      </SettingRow>
      {orphans.length === 0 ? (
        <p className="px-3 py-3 text-muted-foreground">No orphans; every folder belongs to an agent.</p>
      ) : (
        <ul aria-label="Orphans" className="divide-y divide-border">
          {orphans.map((orphan) => (
            <OrphanRow
              key={orphan.path}
              orphan={orphan}
              picked={picked.has(orphan.path)}
              onToggle={(on) => {
                setPicked((before) => {
                  const next = new Set(before)
                  if (on) {
                    next.add(orphan.path)
                  } else {
                    next.delete(orphan.path)
                  }
                  return next
                })
              }}
            />
          ))}
        </ul>
      )}
    </SettingsCard>
  )
}
