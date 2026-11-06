import { Square } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { refreshResources } from '@/hooks/useResources'

/** Ends the task's running turn through the task's own stop route; the process stays open. */
export function StopTurnButton({ taskId, title }: { taskId: string; title: string }) {
  const [stopping, setStopping] = useState(false)
  const stop = async () => {
    setStopping(true)
    try {
      await apiPost(`/tasks/${taskId}/stop`)
      toast.success(`Stopped "${title}"`)
      refreshResources()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setStopping(false)
    }
  }
  return (
    <Button
      variant="destructive"
      size="xs"
      disabled={stopping}
      aria-label={`Stop ${title}`}
      title="Stop this agent's turn"
      onClick={() => void stop()}
    >
      <Square />
      Stop
    </Button>
  )
}
