import { useEffect } from 'react'
import { toast } from 'sonner'

const LIST_FAILED = 'agent-list-failed'

/**
 * Says why the agent list is not current: in the list while it has nothing to show, else as one
 * toast that goes once the list loads again.
 */
export function ListFailure({ error, loaded }: { error: string | null; loaded: boolean }) {
  useEffect(() => {
    if (error === null || !loaded) {
      toast.dismiss(LIST_FAILED)
    } else {
      toast.error('The agent list is not updating', { id: LIST_FAILED, description: error, duration: Infinity })
    }
  }, [error, loaded])

  if (error === null || loaded) {
    return null
  }
  return (
    <p role="status" className="p-4 text-sm text-muted-foreground">
      {error}
    </p>
  )
}
