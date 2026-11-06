import {
  STALE_FOLDER_DAYS_DEFAULT,
  type DeleteStaleFoldersInput,
  type StaleFolder,
  type StaleFolderDeleteResult,
  type StaleFolderReport,
} from '@seti/shared'
import { ScanSearch, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useConfirm } from '@/components/ui/confirm-context'
import { bytesLabel } from '@/panels/resources/format'
import { SettingRow, SettingsCard } from './layout'

const TITLE = 'Stale folders'

const folders = (count: number) => `${String(count)} ${count === 1 ? 'folder' : 'folders'}`

const sizeOf = (folder: StaleFolder) => (folder.bytes === null ? 'size unknown' : bytesLabel(folder.bytes))

const CHECKOUT_WORDS = { repo: ', a checkout', worktree: ', a worktree' } as const

function note(folder: StaleFolder): string {
  const checkout = folder.checkout === null ? '' : CHECKOUT_WORDS[folder.checkout]
  return `${sizeOf(folder)}${checkout}${folder.busy === null ? '' : ', in use'}`
}

function FolderList({
  report,
  picked,
  onToggle,
}: {
  report: StaleFolderReport
  picked: ReadonlySet<string>
  onToggle: (path: string, on: boolean) => void
}) {
  if (report.folders.length === 0) {
    return (
      <p className="px-3 py-3 text-muted-foreground">Nothing is stale; every folder has an owner or changed lately.</p>
    )
  }
  return (
    <ul aria-label="Stale folders" className="divide-y divide-border">
      {report.folders.map((folder) => (
        <li key={folder.path}>
          <label className="flex min-h-9 items-center gap-3 px-3 py-2 pointer-coarse:min-h-11">
            <Checkbox
              checked={picked.has(folder.path)}
              disabled={folder.busy !== null}
              onCheckedChange={(on) => {
                onToggle(folder.path, on === true)
              }}
            />
            <span className="min-w-0 flex-1 truncate font-mono" title={folder.path}>
              {folder.path}
            </span>
            <span className="shrink-0 text-muted-foreground" title={folder.busy ?? undefined}>
              {note(folder)}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}

/** Folders in the scratch and worktree roots no agent owns: a dry run, then a confirmed delete. */
export function StaleFoldersCard() {
  const confirm = useConfirm()
  const [report, setReport] = useState<StaleFolderReport | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const scan = async () => {
    setBusy(true)
    try {
      const next = await apiGet<StaleFolderReport>(`/archive/stale-folders?days=${String(STALE_FOLDER_DAYS_DEFAULT)}`)
      setReport(next)
      setPicked(new Set(next.folders.filter((folder) => folder.busy === null).map((folder) => folder.path)))
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const chosen = report?.folders.filter((folder) => picked.has(folder.path)) ?? []
  const chosenBytes = chosen.reduce((sum, folder) => sum + (folder.bytes ?? 0), 0)

  const remove = async () => {
    const message = `Delete ${folders(chosen.length)}, ${bytesLabel(chosenBytes)}, for good? Anything in them that is not pushed is lost.`
    if (!(await confirm({ title: 'Delete stale folders', message, confirmLabel: 'Delete', variant: 'destructive' }))) {
      return
    }
    setBusy(true)
    try {
      const body: DeleteStaleFoldersInput = {
        paths: chosen.map((folder) => folder.path),
        days: report?.days ?? STALE_FOLDER_DAYS_DEFAULT,
        confirm: true,
      }
      const result = await apiPost<StaleFolderDeleteResult>('/archive/stale-folders/delete', body)
      const freed = result.deleted.reduce((sum, folder) => sum + (folder.bytes ?? 0), 0)
      const kept = result.refused.length > 0 ? `; kept ${folders(result.refused.length)}` : ''
      toast.success(`Deleted ${folders(result.deleted.length)}, freed ${bytesLabel(freed)}${kept}`)
      await scan()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsCard
      title={TITLE}
      actions={
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void scan()}>
          <ScanSearch />
          {report === null ? 'Scan' : 'Rescan'}
        </Button>
      }
    >
      <SettingRow
        label="Unowned folders"
        stack
        description={
          report === null
            ? `Lists folders in the scratch and worktree roots that no agent owns and that nothing changed for ${String(STALE_FOLDER_DAYS_DEFAULT)} days. Scanning changes nothing.`
            : `${folders(report.folders.length)} in ${report.roots.scratch} and ${report.roots.worktrees}, ${bytesLabel(report.total_bytes)} in all.`
        }
      >
        {report !== null && (
          <Button variant="destructive" size="sm" disabled={busy || chosen.length === 0} onClick={() => void remove()}>
            <Trash2 />
            Delete {String(chosen.length)}
          </Button>
        )}
      </SettingRow>
      {report !== null && (
        <FolderList
          report={report}
          picked={picked}
          onToggle={(path, on) => {
            setPicked((before) => {
              const next = new Set(before)
              if (on) {
                next.add(path)
              } else {
                next.delete(path)
              }
              return next
            })
          }}
        />
      )}
    </SettingsCard>
  )
}
