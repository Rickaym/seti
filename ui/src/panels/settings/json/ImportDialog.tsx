import { pathText, type SettingsImportPreview, type SettingsPatchResult } from '@seti/shared'
import { Check, ExternalLink, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { navigate } from '@/lib/route'
import { ChangeItem } from './PreviewDialog'
import { shown } from './json-edit'
import { announceSaved } from './write-client'

function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="space-y-1">
      <h3 className="text-xs font-semibold">{label}</h3>
      <ul className="border border-border px-3">{children}</ul>
    </section>
  )
}

function Offered({
  preview,
  accepted,
  onAccept,
}: {
  preview: SettingsImportPreview
  accepted: ReadonlySet<string>
  onAccept: (id: string, on: boolean) => void
}) {
  return (
    <Part label="Confirm each">
      {preview.offered.map((item) => (
        <li key={item.id} className="flex items-start gap-2 border-b border-border py-2 last:border-b-0">
          <Checkbox
            aria-label={`Import ${pathText(item.path)}`}
            className="mt-0.5"
            checked={accepted.has(item.id)}
            onCheckedChange={(on) => {
              onAccept(item.id, on === true)
            }}
          />
          <div className="min-w-0 space-y-0.5 font-mono text-xs wrap-anywhere">
            <div className="font-medium">{pathText(item.path)}</div>
            <div>{shown(item.after)}</div>
          </div>
        </li>
      ))}
    </Part>
  )
}

function Skipped({ preview }: { preview: SettingsImportPreview }) {
  return (
    <Part label="Not imported">
      {preview.skipped.map((item) => (
        <li
          key={pathText(item.path)}
          className="flex flex-wrap items-center gap-x-2 border-b border-border py-2 text-xs last:border-b-0"
        >
          <span className="font-mono font-medium wrap-anywhere">{pathText(item.path)}</span>
          <span className="min-w-0 flex-1 text-muted-foreground">{item.message}</span>
          {item.page !== undefined && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                navigate('settings', item.page)
              }}
            >
              <ExternalLink />
              Open page
            </Button>
          )}
        </li>
      ))}
    </Part>
  )
}

/**
 * What a settings file would change, before anything applies: plain settings apply together,
 * settings that decide what agents may reach apply only when ticked, and the rest is listed as
 * not imported with the page where it changes.
 */
export function ImportDialog({
  file,
  preview,
  onClose,
  onImported,
}: {
  file: Record<string, unknown>
  preview: SettingsImportPreview
  onClose: () => void
  onImported: () => void
}) {
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const blocked = preview.problems.length > 0
  const count = preview.changes.length + accepted.size
  const apply = async () => {
    setBusy(true)
    try {
      const body = { file, accept: [...accepted], confirm: preview.confirm.map((item) => item.id) }
      const result = await apiPost<SettingsPatchResult>('/settings-doc/import', body)
      announceSaved(result, onImported)
      onImported()
      onClose()
    } catch (e) {
      toast.error(errorText(e), { duration: Infinity })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import settings</DialogTitle>
        </DialogHeader>
        {blocked && (
          <Part label="Not valid">
            {preview.problems.map((problem) => (
              <li key={pathText(problem.path)} className="py-2 text-xs text-destructive wrap-anywhere">
                {pathText(problem.path)}: {problem.message}
              </li>
            ))}
          </Part>
        )}
        {preview.changes.length > 0 && (
          <Part label="Changes">
            {preview.changes.map((row) => (
              <ChangeItem key={row.id} row={row} />
            ))}
          </Part>
        )}
        {preview.offered.length > 0 && (
          <Offered
            preview={preview}
            accepted={accepted}
            onAccept={(id, on) => {
              setAccepted((was) => new Set(on ? [...was, id] : [...was].filter((item) => item !== id)))
            }}
          />
        )}
        {preview.skipped.length > 0 && <Skipped preview={preview} />}
        {preview.confirm.map((item) => (
          <p key={item.id} className="flex gap-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {item.consequence}
          </p>
        ))}
        {count === 0 && !blocked && (
          <p className="text-xs text-muted-foreground">Nothing in this file changes a setting here.</p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || blocked || count === 0} onClick={() => void apply()}>
            <Check />
            {preview.confirm.length > 0 ? 'Confirm' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
