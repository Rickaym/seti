import { FlaskConical } from 'lucide-react'
import { demoResetsAt } from '@/lib/demo'

const resetTime = (at: Date) => at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The demo's badge and what it means; renders nothing outside the demo. */
export function DemoNotice() {
  const resetsAt = demoResetsAt()
  if (resetsAt === null) {
    return null
  }
  return (
    <div
      role="note"
      aria-label="Demo"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-4 py-1 text-xs text-muted-foreground"
    >
      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-primary px-1.5 py-0.5 font-semibold text-primary-foreground">
        <FlaskConical className="size-3" aria-hidden />
        Demo
      </span>
      <span className="min-w-0">
        Nothing here is real: the agents are scripted, the repos and PRs are made up, and everything resets at{' '}
        {resetTime(resetsAt)}.
      </span>
    </div>
  )
}
