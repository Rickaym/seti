import { Check, Trash2, X } from 'lucide-react'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { ConfirmContext, type ConfirmFn, type ConfirmOptions } from '@/components/ui/confirm-context'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<ConfirmOptions>({ message: '' })
  const resolveRef = useRef<((value: boolean) => void) | null>(null)

  const confirm: ConfirmFn = useCallback(async (next) => {
    setOptions(next)
    setOpen(true)
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const VariantIcon = options.variant === 'destructive' ? Trash2 : Check
  const ConfirmIcon = options.icon ?? VariantIcon

  const close = (result: boolean) => {
    setOpen(false)
    resolveRef.current?.(result)
    resolveRef.current = null
  }

  return (
    <ConfirmContext value={confirm}>
      {children}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            close(false)
          }
        }}
      >
        <DialogContent className="!max-w-sm gap-4">
          <DialogHeader>
            <DialogTitle>{options.title ?? 'Confirm'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <p className={options.detail === undefined ? 'text-muted-foreground' : 'text-foreground'}>
              {options.message}
            </p>
            {options.detail !== undefined && <p className="text-muted-foreground">{options.detail}</p>}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                close(false)
              }}
            >
              <X />
              {options.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={options.variant === 'destructive' ? 'destructive' : 'default'}
              size="sm"
              onClick={() => {
                close(true)
              }}
            >
              <ConfirmIcon />
              {options.confirmLabel ?? 'Confirm'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext>
  )
}
