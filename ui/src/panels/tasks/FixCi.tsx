import { fixCiPlanSchema, fixCiPrCount, fixCiReach, fixCiSkipped, type FixCiPlan, type FixCiPr } from '@seti/shared'
import { Wrench } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { CountBadge } from '@/components/CountBadge'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePolled } from '@/hooks/usePolled'
import { createPolledResource } from '@/lib/polled'
import { askToFixCi, prCount, useFixCi, type PrAgent } from '@/panels/tasks/fix-ci'

const INLINE =
  'flex h-6 -my-1.5 shrink-0 items-center gap-1 text-xs whitespace-nowrap text-destructive hover:underline pointer-coarse:-my-3.5 pointer-coarse:h-11'

interface AgentFixCiProps {
  agent: PrAgent
  /** The agent's open PRs with failing CI; with none there is no button. */
  prs: readonly FixCiPr[]
  /** A text button on the line of PR chips, where a filled button would crowd the header. */
  inline?: boolean
  onSent?: () => void
}

/** One Fix CI for every failing PR of an agent: one click, one short message naming them all. */
export function AgentFixCi({ agent, prs, inline = false, onSent }: AgentFixCiProps) {
  const fix = useFixCi(agent)
  if (prs.length === 0) {
    return null
  }
  const send = () => {
    fix(prs)
    onSent?.()
  }
  const covered = prs.length === 1 ? 'its 1 PR' : `all ${prCount(prs.length)}`
  const hint = `Ask the agent to fix failing CI on ${covered}`
  if (inline) {
    return (
      <Hint text={hint}>
        <button type="button" className={INLINE} data-testid="fix-ci-all" onClick={send}>
          <Wrench className="size-3.5" />
          Fix CI
        </button>
      </Hint>
    )
  }
  return (
    <Hint text={hint}>
      <Button size="xs" className="shrink-0 pointer-coarse:min-h-11" data-testid="fix-ci-all" onClick={send}>
        <Wrench />
        Fix CI
      </Button>
    </Hint>
  )
}

const plans = createPolledResource('/prs/fix-ci', 60_000, { schema: fixCiPlanSchema })

function sendPlan(plan: FixCiPlan): void {
  for (const { task, message } of plan.nudges) {
    askToFixCi(task, message)
  }
  const skipped = fixCiSkipped(plan)
  toast.success(`Asked ${fixCiReach(plan)} to fix CI`, skipped === '' ? undefined : { description: skipped })
}

/**
 * Fix CI for every agent at once, shown while an agent has an open PR with failing CI. It says
 * who it reaches and what it skips before it sends each agent its own short message.
 */
export function FixCiEverywhere() {
  const plan = usePolled(plans).data
  const [open, setOpen] = useState(false)
  if (plan === undefined || plan.nudges.length === 0) {
    return null
  }
  const reach = fixCiReach(plan)
  const skipped = fixCiSkipped(plan)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          plans.refresh()
        }
      }}
    >
      <Hint text={`Fix CI: nudge ${reach}`}>
        <PopoverTrigger asChild>
          <Button size="icon-sm" variant="outline" className="relative" aria-label="Fix CI">
            <Wrench />
            <CountBadge aria-hidden>{fixCiPrCount(plan)}</CountBadge>
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="end" aria-label="Fix CI" className="grid w-72 max-w-[calc(100vw-1rem)] gap-2 text-xs">
        <div className="font-medium">Nudge {reach}</div>
        <ul className="grid max-h-40 gap-0.5 overflow-y-auto text-muted-foreground">
          {plan.nudges.map(({ task, prs }) => (
            <li key={task.id} className="flex min-w-0 justify-between gap-2">
              <span className="min-w-0 truncate">{task.title}</span>
              <span className="shrink-0 tabular-nums">{prCount(prs.length)}</span>
            </li>
          ))}
        </ul>
        {skipped !== '' && <p className="text-muted-foreground">{skipped}</p>}
        <Button
          size="sm"
          className="justify-self-start pointer-coarse:min-h-11"
          onClick={() => {
            sendPlan(plan)
            setOpen(false)
          }}
        >
          <Wrench />
          Nudge
        </Button>
      </PopoverContent>
    </Popover>
  )
}
