import type { ModKit } from '@seti/mod-api'
import type { ComponentProps } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

/** Seti's dialog with a title, for mods that draw one. */
export function KitDialog({ open, onOpenChange, title, className, children }: ComponentProps<ModKit['Dialog']>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} className={className}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}
