import type { RequestPr } from '@seti/shared'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { TOUCH_TARGET } from '@/lib/touch'
import { CiBadge } from '@/panels/tasks/pr-badges'

/** Chips a request card shows before the rest fold into "+N". */
const SHOWN = 3

/** The short name the agent header's chips use, such as tool#2136. */
const labelOf = (pr: RequestPr) => `${pr.repo.split('/').at(-1) ?? pr.repo}#${String(pr.number)}`

function RequestPrChip({ pr }: { pr: RequestPr }) {
  const label = labelOf(pr)
  return (
    <span className="flex min-w-0 items-center gap-1.5" role="group" aria-label={`Pull request ${label}`}>
      <GitPullRequest className="size-3 shrink-0" />
      <span className="shrink-0 text-primary">{label}</span>
      {pr.title !== null && (
        <Hint text={pr.title}>
          <span className="min-w-0 truncate">{pr.title}</span>
        </Hint>
      )}
      <CiBadge state={pr.ci} />
      <Hint text={`Open ${pr.repo}#${String(pr.number)} on GitHub`}>
        <a
          className={TOUCH_TARGET}
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${label} on GitHub`}
        >
          <ExternalLink className="size-3" />
        </a>
      </Hint>
    </span>
  )
}

/** The pull requests a request's command names, three at most, then how many more; none, nothing. */
export function RequestPrs({ prs }: { prs: readonly RequestPr[] }) {
  const more = prs.slice(SHOWN)
  if (prs.length === 0) {
    return null
  }
  return (
    <div className="flex min-w-0 flex-col gap-1" aria-label="Pull requests" role="group">
      {prs.slice(0, SHOWN).map((pr) => (
        <RequestPrChip key={pr.url} pr={pr} />
      ))}
      {more.length > 0 && (
        <Hint text={more.map(labelOf).join(', ')}>
          <span className="w-fit text-muted-foreground">+{more.length}</span>
        </Hint>
      )}
    </div>
  )
}
