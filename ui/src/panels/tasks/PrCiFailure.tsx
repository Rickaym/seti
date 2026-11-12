import type { PullRequest, TaskListEntry } from '@seti/shared'
import { ExternalLink, Wrench } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { toast } from 'sonner'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { sendAsUser } from '@/hooks/usePendingSends'
import { navigate, parseHash } from '@/lib/route'
import { useAgentFrame } from '@/panels/tasks/agent-frame'
import { CheckIcon, CiBadge } from '@/panels/tasks/pr-badges'
import { checkOutcome, failingChecks, fixCiMessage } from '@/panels/tasks/pr-ci'

/** The agent a PR belongs to: the one it is linked to, or the parent of the subagent it is. */
export type PrAgent = Pick<TaskListEntry, 'id' | 'title'>

const viewing = (agentId: string) => {
  const route = parseHash()
  return route.section === 'agents' && route.id === agentId && route.sub === null
}

interface FailingChecksProps {
  pr: PullRequest
  agent: PrAgent
  /** Closes the popover or sheet the checks show in, once Fix CI has sent its message. */
  onSent: () => void
}

/** Each failing check of a PR with how it ended and its log, then Fix CI, which tells its agent. */
export function FailingChecks({ pr, agent, onSent }: FailingChecksProps) {
  const failing = failingChecks(pr)
  const framed = useAgentFrame() !== null
  const fix = () => {
    sendAsUser(agent.id, fixCiMessage(pr))
    onSent()
    if (!framed && !viewing(agent.id)) {
      navigate('agents', agent.id)
    }
    toast.success(`Asked ${agent.title} to fix CI on #${String(pr.number)}`)
  }
  return (
    <div className="grid gap-1.5" data-testid="failing-checks">
      {failing.length > 0 && (
        <ul className="grid gap-0.5">
          {failing.map((check, index) => (
            <li
              key={`${String(index)}-${check.name}`}
              className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs"
              data-testid="failing-check"
            >
              <CheckIcon state={check.state} />
              <span className="min-w-0 truncate font-medium">{check.name}</span>
              <span className="text-destructive">{checkOutcome(check)}</span>
              {check.url !== null && (
                <a
                  className="inline-flex items-center gap-1 text-primary hover:underline pointer-coarse:min-h-11"
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open the ${check.name} log`}
                >
                  Log
                  <ExternalLink className="size-3" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      <Hint text="Ask the agent to fix the failing checks">
        <Button size="xs" className="justify-self-start pointer-coarse:min-h-11" onClick={fix}>
          <Wrench />
          Fix CI
        </Button>
      </Hint>
    </div>
  )
}

/** The failing CI badge as a button; the popover of failing checks opens from it. */
export function FailingCiButton({ label, ...props }: { label: string } & ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className="flex shrink-0 items-center pointer-coarse:-my-3 pointer-coarse:min-h-11"
      aria-label={`Failing checks of ${label}`}
      {...props}
    >
      <CiBadge state="failure" />
    </button>
  )
}

/** The CI badge of a failing PR, opening its failing checks and Fix CI. */
export function FailingCiBadge({ pr, label, agent }: { pr: PullRequest; label: string; agent: PrAgent }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Hint text="Failing checks and Fix CI">
        <PopoverTrigger asChild>
          <FailingCiButton label={label} />
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-1rem)]">
        <div className="mb-2 text-xs font-medium">Failing checks of {label}</div>
        <FailingChecks
          pr={pr}
          agent={agent}
          onSent={() => {
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
