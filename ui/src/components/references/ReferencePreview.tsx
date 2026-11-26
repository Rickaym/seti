import { LinkIcon } from '@/components/links/LinkPill'
import { NotRead, VerifiedMark } from '@/components/references/source-marks'
import { sourceFacts, useSourceMatch } from '@/components/references/source-match'
import type { SourceLabel } from '@/lib/references/reference-label'
import type { Reference } from '@/lib/references/reference-set'

/** What a reference's card and sheet show: its label, host, footnote words and quote, as text. */
export function ReferencePreview({ reference, label }: { reference: Reference; label: SourceLabel }) {
  const match = useSourceMatch(reference)
  const facts = sourceFacts(match, label.label)
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="reference-preview">
      <p className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
        <LinkIcon info={label} className="size-3.5" />
        <span className="min-w-0 truncate">{label.label}</span>
      </p>
      {label.host !== null && <p className="truncate text-muted-foreground">{label.host}</p>}
      {facts !== null && (
        <p className="truncate text-muted-foreground" data-testid="source-facts">
          {facts}
        </p>
      )}
      {match?.unread === true && <NotRead />}
      {reference.href !== null && reference.note !== null && (
        <p className="break-words text-muted-foreground">{reference.note}</p>
      )}
      {reference.quote !== null && (
        <div className="flex items-start gap-1">
          <blockquote className="min-w-0 flex-1 border-l-2 border-border pl-2 break-words text-muted-foreground">
            {reference.quote}
          </blockquote>
          {match?.verified === true && <VerifiedMark />}
        </div>
      )}
    </div>
  )
}
