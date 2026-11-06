import { ArrowLeft } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'
import { needsYouLabel, useNeedsYou } from '@/hooks/useNeedsYou'
import { goUp } from '@/lib/route'

const BADGE_MAX = 9

/** Back to the agent list, badged with how many agents need you while the status bar steps aside. */
export function PhoneBack() {
  const count = useNeedsYou().titles.length
  const note = useId()
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="relative -ml-2 shrink-0"
      aria-label="Back to agents"
      aria-describedby={count > 0 ? note : undefined}
      onClick={() => {
        goUp('agents')
      }}
    >
      <ArrowLeft />
      {count > 0 && (
        <span
          id={note}
          data-testid="needs-you-badge"
          className="absolute top-1 right-0.5 min-w-4 rounded-full bg-destructive px-1 text-2xs/4 font-semibold text-primary-foreground tabular-nums"
        >
          <span aria-hidden>{count > BADGE_MAX ? `${String(BADGE_MAX)}+` : count}</span>
          <span className="sr-only">{needsYouLabel(count)}</span>
        </span>
      )}
    </Button>
  )
}
