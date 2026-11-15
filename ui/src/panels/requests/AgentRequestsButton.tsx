import { Inbox } from 'lucide-react'
import { CountBadge } from '@/components/CountBadge'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { useAgentRequestCount } from '@/hooks/useRequests'
import { requestsText } from '@/panels/requests/label'

interface AgentRequestsButtonProps {
  taskId: string
  /** Opens or closes the agent's Requests drawer. */
  onToggle: () => void
  compact?: boolean
}

/** The agent's pending requests in its header, which open its drawer; hidden while none are. */
export function AgentRequestsButton({ taskId, onToggle, compact = false }: AgentRequestsButtonProps) {
  const count = useAgentRequestCount(taskId)
  if (count === 0) {
    return null
  }
  return (
    <Hint text="Answer this agent's requests beside it">
      <Button
        variant="outline"
        size={compact ? 'icon-sm' : 'sm'}
        className="relative"
        aria-label={`Answer ${requestsText(count)}`}
        onClick={onToggle}
      >
        <Inbox />
        {compact ? <CountBadge aria-hidden>{count}</CountBadge> : requestsText(count)}
      </Button>
    </Hint>
  )
}
