import type { WebhookFilterOutcome, WebhookFilterTestResult, WebhookFilterTestRow } from '@seti/shared'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

const FILTER_TONE: Record<WebhookFilterOutcome, string> = {
  kept: 'text-success',
  changed: 'text-info',
  dropped: 'text-muted-foreground',
  failed: 'text-destructive',
}

function changes(row: WebhookFilterTestRow): string {
  if (row.changed === null) {
    return ''
  }
  return Object.entries(row.changed)
    .map(([field, value]) => `${field}: ${value === '' ? 'none' : value}`)
    .join('; ')
}

function TestRow({ row }: { row: WebhookFilterTestRow }) {
  const detail = [row.error ?? '', changes(row), ...row.logs].filter((line) => line !== '')
  return (
    <li className="border-b border-border px-2 py-1.5 last:border-b-0" data-outcome={row.outcome}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={cn('w-16 shrink-0 font-semibold uppercase', FILTER_TONE[row.outcome])}>{row.outcome}</span>
        <span className="min-w-0 flex-1 break-words">
          <code className="text-muted-foreground">{row.event === '' ? 'no name' : row.event}</code> {row.title}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {row.source === 'sample' ? 'sample' : relativeTime(row.received_at ?? '')}
        </span>
      </div>
      {detail.length > 0 && (
        <pre className="mt-1 max-h-32 overflow-auto bg-muted p-1.5 text-2xs break-all whitespace-pre-wrap">
          {detail.join('\n')}
        </pre>
      )}
    </li>
  )
}

/** What the filter made of each recent delivery and of the pasted sample. */
export function FilterTestView({ result }: { result: WebhookFilterTestResult }) {
  return (
    <section aria-label="Filter test result" className="col-span-full space-y-1 border border-border p-2">
      {result.sample_error !== null && <p className="text-destructive">{result.sample_error}</p>}
      {result.rows.length === 0 ? (
        <p className="text-muted-foreground">No recent deliveries to try yet; paste a sample.</p>
      ) : (
        <ul aria-label="Filter test rows">
          {result.rows.map((row, index) => (
            <TestRow key={`${row.source}:${row.received_at ?? ''}:${String(index)}`} row={row} />
          ))}
        </ul>
      )}
    </section>
  )
}
