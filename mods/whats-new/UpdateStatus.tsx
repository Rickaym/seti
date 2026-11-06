import type { SetiUpdate, SetiVersion } from '@seti/mod-api'
import { CircleArrowUp, CircleCheck, CircleHelp, ExternalLink, LoaderCircle } from 'lucide-react'
import { cn, compareUrl, commitUrl, shortCommit } from './changelog-days'
import { useWhatsNew } from './mod-context'

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`

/** The running commit as a link, and when it was made. */
export function RunningVersion({ version }: { version: SetiVersion }) {
  return (
    <>
      <a
        href={commitUrl(version.commit)}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-foreground underline underline-offset-2"
      >
        {shortCommit(version.commit)}
      </a>
      , committed {new Date(version.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
    </>
  )
}

function summary(update: SetiUpdate): string {
  switch (update.state) {
    case 'current':
      return `Up to date with ${update.branch}`
    case 'available': {
      const behind = plural(update.behind ?? 0, `new commit on ${update.branch}`, `new commits on ${update.branch}`)
      const notable =
        update.notable === null ? '' : `, ${plural(update.notable, 'feature or fix', 'features and fixes')}`
      return `Update available: ${behind}${notable}`
    }
    case 'unknown':
      return `Could not check for updates: ${update.error ?? 'no answer yet'}`
  }
}

const ICONS = { current: CircleCheck, available: CircleArrowUp, unknown: CircleHelp }

/** Whether a newer Seti waits on the branch, and the commands that install it. */
export function UpdateStatus({ update, running }: { update: SetiUpdate | null; running: SetiVersion | null }) {
  const { CopyButton } = useWhatsNew().api.kit
  if (update === null) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Checking for updates...
      </p>
    )
  }
  const Icon = ICONS[update.state]
  const available = update.state === 'available'
  return (
    <div data-update={update.state} className="space-y-2 text-xs">
      <p className={cn('flex items-start gap-2', available ? 'text-foreground' : 'text-muted-foreground')}>
        <Icon aria-hidden className={cn('mt-px size-4 shrink-0', available && 'text-primary')} />
        <span className="min-w-0 wrap-anywhere">
          {summary(update)}
          {available && running !== null && update.latest !== null && (
            <a
              href={compareUrl(running.commit, update.latest.commit)}
              target="_blank"
              rel="noreferrer"
              className="ml-2 inline-flex items-center gap-1 underline underline-offset-2"
            >
              Compare
              <ExternalLink aria-hidden className="size-3" />
            </a>
          )}
        </span>
      </p>
      {available && update.command !== '' && (
        <div className="border border-border bg-muted/40">
          <div className="flex items-center justify-between gap-2 border-b border-border py-0.5 pr-1 pl-2">
            <span className="text-muted-foreground">To update, run this on the Seti host</span>
            <CopyButton text={update.command} label="Update command" />
          </div>
          <pre aria-label="Update command" className="overflow-x-auto p-2 font-mono text-xs">
            {update.command}
          </pre>
        </div>
      )}
    </div>
  )
}
