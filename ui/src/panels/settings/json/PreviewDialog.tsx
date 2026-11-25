import { pathText, type SettingsConfirm } from '@seti/shared'
import { Check, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { shown, type ChangeRow } from './json-edit'

function Row({ row }: { row: ChangeRow }) {
  return (
    <li className="space-y-0.5 border-b border-border py-2 last:border-b-0">
      <div className="font-mono text-xs font-medium wrap-anywhere">{pathText(row.path)}</div>
      <div className="font-mono text-xs wrap-anywhere text-muted-foreground line-through">{shown(row.before)}</div>
      <div className="font-mono text-xs wrap-anywhere">{shown(row.after)}</div>
    </li>
  )
}

/**
 * The changes a save makes, old value struck through above the new one, before anything applies;
 * with a confirm step for changes that have a consequence.
 */
export function PreviewDialog({
  rows,
  confirm,
  busy,
  onSave,
  onClose,
}: {
  rows: ChangeRow[]
  /** Consequences to confirm, or empty when there are none. */
  confirm: SettingsConfirm[]
  busy: boolean
  onSave: () => void
  onClose: () => void
}) {
  const confirming = confirm.length > 0
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{rows.length === 1 ? 'Save 1 change' : `Save ${String(rows.length)} changes`}</DialogTitle>
        </DialogHeader>
        <ol aria-label="Changes" className="max-h-[50vh] overflow-y-auto">
          {rows.map((row) => (
            <Row key={pathText(row.path)} row={row} />
          ))}
        </ol>
        {confirming && (
          <ul aria-label="Consequences" className="space-y-1">
            {confirm.map((item) => (
              <li key={item.id} className="flex gap-2 text-xs text-warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {item.consequence}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">One change in the history: Undo reverts all of it.</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={confirming ? 'destructive' : 'default'} disabled={busy} onClick={onSave}>
            <Check />
            {confirming ? 'Confirm' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
