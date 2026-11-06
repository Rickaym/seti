import { useEffect } from 'react'
import { useConfirm } from '@/components/ui/confirm-context'
import { addLeaveGuard } from '@/lib/leave-guard'

/** While `dirty`, in-app navigation asks before discarding and closing the tab warns. */
export function useLeaveGuard(dirty: boolean) {
  const confirm = useConfirm()
  useEffect(() => {
    if (!dirty) {
      return undefined
    }
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    const remove = addLeaveGuard(async () => confirm({ message: 'Discard unsaved changes?', confirmLabel: 'Discard' }))
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      remove()
    }
  }, [dirty, confirm])
}
