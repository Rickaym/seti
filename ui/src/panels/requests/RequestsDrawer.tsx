import { requestCount } from '@seti/shared'
import { Inbox, X } from 'lucide-react'
import { useEffect } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useAgentRequests } from '@/hooks/useRequests'
import { RequestsView } from '@/panels/requests/RequestsView'
import { REQUESTS } from '@/panels/requests/label'

/** One agent's pending requests of every kind beside it; it closes itself once none are left. */
export function RequestsDrawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { requests, loaded } = useAgentRequests(taskId)
  const settled = loaded && requestCount(requests) === 0
  useEffect(() => {
    if (settled) {
      onClose()
    }
  }, [settled, onClose])
  return (
    <section aria-label="Agent requests" className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Inbox aria-hidden className="size-4 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{REQUESTS.label}</h2>
        <Hint text={`Close ${REQUESTS.label}; the agent keeps waiting`}>
          <Button variant="ghost" size="icon-sm" aria-label={`Close ${REQUESTS.label}`} onClick={onClose}>
            <X />
          </Button>
        </Hint>
      </div>
      <RequestsView requests={requests} submitLabel="Submit" bare onEmpty={onClose} />
    </section>
  )
}
