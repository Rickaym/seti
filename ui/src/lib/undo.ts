import { toast } from 'sonner'
import { errorText } from '@/api'

/** Confirms a one-tap removal with a toast whose Undo puts it back. */
export function toastUndo(message: string, undo: () => Promise<void>): void {
  toast.success(message, {
    action: {
      label: 'Undo',
      onClick: () => {
        undo().catch((e: unknown) => {
          toast.error(errorText(e))
        })
      },
    },
  })
}
