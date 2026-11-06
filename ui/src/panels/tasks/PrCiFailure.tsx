import type { PullRequest } from '@seti/shared'
import { ExternalLink, Wrench } from 'lucide-react'
import { useState, type ComponentProps } from 'react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { openStartPage } from '@/lib/start-context'
import { CheckIcon, CiBadge } from '@/panels/tasks/pr-badges'
import { checkOutcome, failingChecks, fixCiPrompt } from '@/panels/tasks/pr-ci'

function startFixCi(pr: PullRequest): void {
  openStartPage({
    label: `Fix CI on #${String(pr.number)} in ${pr.repo_slug}`,
    prompt: fixCiPrompt(pr),
    title: `Fix CI #${String(pr.number)}: ${pr.title}`,
    repo_ids: [pr.repo_id],
    ref: pr.head_ref,
    pr_urls: [pr.url],
  })
}

/** Each failing check of a PR with how it ended and its log, then Fix CI. */
export function FailingChecks({ pr, onStart }: { pr: PullRequest; onStart: () => void }) {
  const failing = failingChecks(pr)
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
      <Hint text="Start an agent on this branch with the failing checks in its prompt">
        <Button
          size="xs"
          className="justify-self-start pointer-coarse:min-h-11"
          onClick={() => {
            onStart()
            startFixCi(pr)
          }}
        >
          <Wrench />
          Fix CI
        </Button>
      </Hint>
    </div>
  )
}

/** The CI badge of a failing PR, opening its failing checks and Fix CI. */
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

export function FailingCiBadge({ pr, label }: { pr: PullRequest; label: string }) {
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
          onStart={() => {
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
