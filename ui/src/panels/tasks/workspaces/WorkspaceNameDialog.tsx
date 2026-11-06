import { WORKSPACE_NAME_MAX } from '@seti/shared'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface WorkspaceNameDialogProps {
  title: string
  initial: string
  confirmLabel: string
  /** Resolves true when the name was taken, which closes the dialog. */
  onSubmit: (name: string) => Promise<boolean>
  onClose: () => void
}

/** Names a new workspace or renames one. */
export function WorkspaceNameDialog({ title, initial, confirmLabel, onSubmit, onClose }: WorkspaceNameDialogProps) {
  const [name, setName] = useState(initial)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const trimmed = name.trim()
  const submit = async () => {
    if (trimmed === '' || saving) {
      return
    }
    setSaving(true)
    if (await onSubmit(trimmed)) {
      onClose()
      return
    }
    setSaving(false)
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
      <DialogContent
        aria-describedby={undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          input.current?.focus()
          input.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Input
            ref={input}
            aria-label="Workspace name"
            placeholder="Name"
            value={name}
            maxLength={WORKSPACE_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
          <DialogFooter>
            <Button type="submit" disabled={trimmed === '' || saving}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
