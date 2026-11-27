import { ChevronDown, Library } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { LinkIcon } from '@/components/links/LinkPill'
import { AsReadAt, NotRead, VerifiedMark } from '@/components/references/source-marks'
import { useSourceMatch } from '@/components/references/source-match'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useNarrow } from '@/hooks/useMedia'
import { useSourceLabel } from '@/lib/references/reference-label'
import type { Reference } from '@/lib/references/reference-set'
import { cn } from '@/lib/utils'

const ENTRY = 'flex min-w-0 flex-1 items-center gap-1.5 pointer-coarse:min-h-11'

function SourceRow({ reference }: { reference: Reference }) {
  const label = useSourceLabel(reference)
  const match = useSourceMatch(reference)
  const marked = match?.unread === true || match?.as_read_at !== undefined
  const content = (
    <>
      <LinkIcon info={label} className="size-3.5" />
      <span className="min-w-0 truncate text-foreground">{label.label}</span>
      {reference.href !== null && reference.note !== null && (
        <span className="min-w-0 truncate text-muted-foreground">{reference.note}</span>
      )}
      {label.host !== null && (
        <span className={cn('shrink-0 text-muted-foreground', marked && 'max-sm:hidden')}>{label.host}</span>
      )}
      {match?.unread === true && <NotRead />}
      {match?.as_read_at !== undefined && <AsReadAt commit={match.as_read_at} />}
      {match?.verified === true && <VerifiedMark />}
    </>
  )
  return (
    <li className="flex min-w-0 items-center gap-1.5" data-source={reference.n}>
      <span className="w-6 shrink-0 text-right text-muted-foreground tabular-nums">[{reference.n}]</span>
      {reference.href === null ? (
        <span className={ENTRY}>{content}</span>
      ) : (
        <a
          href={reference.href}
          target="_blank"
          rel="noreferrer"
          data-link-url={reference.href}
          className={cn(ENTRY, 'hover:underline focus-visible:outline-2 focus-visible:outline-ring')}
        >
          {content}
        </a>
      )}
    </li>
  )
}

function Rows({ refs }: { refs: readonly Reference[] }) {
  return (
    <ol className="space-y-0.5">
      {refs.map((reference) => (
        <SourceRow key={reference.n} reference={reference} />
      ))}
    </ol>
  )
}

const FRAME = 'border-t border-border/60 pt-1 text-xs'
const HEAD = 'flex items-center gap-1.5 text-muted-foreground'

/** On a phone the list folds to one line, such as "3 sources", that opens it. */
function FoldedSources({ refs, children }: { refs: readonly Reference[]; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section aria-label="Sources" className={FRAME} data-testid="sources">
        <CollapsibleTrigger className={cn(HEAD, 'min-h-11 w-full')}>
          <Library className="size-3.5" aria-hidden />
          {refs.length} {refs.length === 1 ? 'source' : 'sources'}
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
        </CollapsibleTrigger>
        <CollapsibleContent>{children}</CollapsibleContent>
      </section>
    </Collapsible>
  )
}

/** The sources a message cites, in mark order, at its end. */
export function SourcesList({ refs }: { refs: readonly Reference[] }) {
  const rows = <Rows refs={refs} />
  if (useNarrow()) {
    return <FoldedSources refs={refs}>{rows}</FoldedSources>
  }
  return (
    <section aria-label="Sources" className={cn(FRAME, 'space-y-0.5')} data-testid="sources">
      <p className={HEAD}>
        <Library className="size-3.5" aria-hidden />
        Sources
      </p>
      {rows}
    </section>
  )
}
