import { Save, X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function CrudEditDialog({
  open,
  title,
  onCancel,
  onSave,
  saving,
  canSave = true,
  saveLabel = 'Save',
  savingLabel = 'Saving...',
  saveIcon: SaveIcon = Save,
  wide = false,
  children,
}: {
  open: boolean
  title: string
  onCancel: () => void
  onSave: () => void
  saving: boolean
  canSave?: boolean
  saveLabel?: string
  savingLabel?: string
  saveIcon?: LucideIcon
  /** Room for code, such as a poller's script. */
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onCancel()
        }
      }}
    >
      <DialogContent
        className={cn(
          'flex max-h-[92vh] min-h-0 flex-col gap-0 overflow-hidden border p-0',
          wide ? 'sm:max-w-4xl' : 'sm:max-w-2xl',
        )}
        onEscapeKeyDown={(e) => {
          if (!(e.target instanceof HTMLElement)) {
            return
          }
          // A code editor keeps Esc as its first step out, Esc then Tab, so a draft never closes on it.
          if (e.target.getAttribute('aria-expanded') === 'true' || e.target.closest('[data-code-editor]') !== null) {
            e.preventDefault()
          }
        }}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
        </div>
        <DialogFooter className="border-t border-border px-4 py-3 sm:justify-end">
          <Button variant="outline" type="button" onClick={onCancel}>
            <X />
            Cancel
          </Button>
          <Button type="button" onClick={onSave} disabled={saving || !canSave}>
            <SaveIcon />
            {saving ? savingLabel : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function Field({ label, full = false, children }: { label: string; full?: boolean; children: ReactNode }) {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-1.5', full && 'col-span-full')}>
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
    </div>
  )
}
