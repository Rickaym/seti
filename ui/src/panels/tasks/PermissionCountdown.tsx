import type { PermissionRequest } from '@seti/shared'
import { useNow } from '@/hooks/useNow'
import { durationLabel } from '@/lib/time'
import { cn } from '@/lib/utils'

const MINUTE_MS = 60_000
const LAST_MINUTES_MS = 5 * MINUTE_MS

/** How long until the request times out: "42m", "2h 5m", or "under 1m" at the end. */
const timeLeftLabel = (ms: number): string => (ms < MINUTE_MS ? 'under 1m' : durationLabel(ms))

/** When Seti denies the unanswered request, quietly; nothing while the timeout is off. */
export function PermissionCountdown({ request }: { request: PermissionRequest }) {
  const now = useNow(request.timeout_at !== null, 15_000)
  if (request.timeout_at === null) {
    return null
  }
  const at = new Date(request.timeout_at)
  const left = at.getTime() - now
  return (
    <span
      className={cn('ml-auto text-2xs text-muted-foreground', left <= LAST_MINUTES_MS && 'text-warning-text')}
      title={`Seti denies this at ${at.toLocaleString()} if nobody answers. The agent is told it timed out and goes on.`}
    >
      denies in {timeLeftLabel(left)}
    </span>
  )
}
