import type { Changelog, ChangelogEntry } from '@seti/mod-api'
import { ChevronRight, ChevronsDown } from 'lucide-react'
import { useState } from 'react'
import { changelogDays, cn, commitUrl, prUrl, shortCommit, typeLabel } from './changelog-days'
import { useWhatsNew } from './mod-context'

const DAYS_PER_PAGE = 7

const TYPE_TONE: Record<string, string> = { feat: 'text-primary', fix: 'text-foreground', perf: 'text-foreground' }

function EntryRow({ entry }: { entry: ChangelogEntry }) {
  const { Markdown, NewsDot } = useWhatsNew().api.kit
  const [open, setOpen] = useState(false)
  const expandable = entry.body !== ''
  const summary = (
    <>
      {entry.unseen ? <NewsDot className="mt-1.5" /> : <span aria-hidden className="size-1.5 shrink-0" />}
      <span
        className={cn(
          'w-14 shrink-0 text-2xs leading-5 font-semibold tracking-wide uppercase',
          TYPE_TONE[entry.type ?? ''] ?? 'text-muted-foreground',
        )}
      >
        {typeLabel(entry.type)}
      </span>
      <span className="min-w-0 flex-1 leading-5 wrap-anywhere">
        {entry.scope !== null && <span className="mr-1.5 font-mono text-xs text-muted-foreground">{entry.scope}</span>}
        {entry.description}
        {entry.breaking && (
          <span className="ml-1.5 border border-border px-1 text-2xs font-semibold text-muted-foreground uppercase">
            Breaking
          </span>
        )}
        {entry.unseen && <span className="sr-only"> (new since you last looked)</span>}
      </span>
      {expandable && (
        <ChevronRight
          aria-hidden
          className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
      )}
    </>
  )
  const rowClass = 'flex min-w-0 flex-1 items-start gap-2 py-1.5 text-left text-sm max-md:min-h-11 max-md:py-2.5'
  return (
    <li data-commit={entry.commit} className="border-b border-border px-3 last:border-b-0">
      <div className="flex items-start gap-3">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open)
            }}
            className={cn(rowClass, 'outline-none focus-visible:ring-2 focus-visible:ring-ring')}
          >
            {summary}
          </button>
        ) : (
          <div className={rowClass}>{summary}</div>
        )}
        <a
          href={entry.pr === null ? commitUrl(entry.commit) : prUrl(entry.pr)}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 py-1.5 font-mono text-xs leading-5 text-muted-foreground hover:text-foreground max-md:flex max-md:min-h-11 max-md:items-center max-md:py-0"
        >
          {entry.pr === null ? shortCommit(entry.commit) : `#${String(entry.pr)}`}
        </a>
      </div>
      {open && <Markdown text={entry.body} className="pb-3 pl-[4.875rem] text-xs max-md:pl-0" />}
    </li>
  )
}

/** Marks where the running deploy's entries end and the ones it already had begin. */
function DeployDivider() {
  return (
    <li
      role="separator"
      aria-label="Earlier deploys"
      className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-1 text-2xs font-semibold tracking-wider text-muted-foreground uppercase"
    >
      Earlier deploys
    </li>
  )
}

function EntryGroup({ entry, divider }: { entry: ChangelogEntry; divider: boolean }) {
  return (
    <>
      {divider && <DeployDivider />}
      <EntryRow entry={entry} />
    </>
  )
}

/** Entries by day, seven days at a time; `onMore` fetches older commits once these run out. */
export function ChangelogList({ log, all, onMore }: { log: Changelog; all: boolean; onMore: (() => void) | null }) {
  const { Button } = useWhatsNew().api.kit
  const [shownDays, setShownDays] = useState(DAYS_PER_PAGE)
  const days = changelogDays(log.entries, all)
  const shown = days.flatMap((day) => day.entries)
  const firstEarlier = shown.some((entry) => entry.current) ? shown.find((entry) => !entry.current) : undefined
  if (days.length === 0) {
    return (
      <p className="border border-border bg-card p-6 text-sm text-muted-foreground">
        No features or fixes in the last {log.entries.length} commits. Turn on All to see upkeep.
      </p>
    )
  }
  const hiddenDays = days.length - shownDays
  return (
    <div className="space-y-4">
      {days.slice(0, shownDays).map((day) => (
        <section key={day.key} aria-label={day.label} className="border border-border bg-card">
          <h3 className="border-b border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            {day.label}
          </h3>
          <ul>
            {day.entries.map((entry) => (
              <EntryGroup key={entry.commit} entry={entry} divider={entry === firstEarlier} />
            ))}
          </ul>
        </section>
      ))}
      {(hiddenDays > 0 || onMore !== null) && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (hiddenDays <= 0) {
              onMore?.()
            }
            setShownDays(shownDays + DAYS_PER_PAGE)
          }}
        >
          <ChevronsDown />
          Older
        </Button>
      )}
    </div>
  )
}
