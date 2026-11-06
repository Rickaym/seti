import type { PollerTestResult } from '@seti/shared'

const SHOWN = 20

/** What a test run returned: its items, the ones Seti could not use, its log and any error. */
export function PollerTestView({ result }: { result: PollerTestResult }) {
  const seconds = (result.duration_ms / 1000).toFixed(1)
  const count = `${String(result.items.length)} ${result.items.length === 1 ? 'item' : 'items'}`
  return (
    <section aria-label="Test run result" className="col-span-full space-y-2 border border-border p-2">
      <p className={result.ok ? 'font-medium' : 'font-medium text-destructive'} data-testid="poller-test-status">
        {result.ok ? `${count} in ${seconds} s` : `Failed after ${seconds} s: ${result.error ?? 'unknown error'}`}
      </p>
      {result.items.length > 0 && (
        <ul aria-label="Test items" className="space-y-1">
          {result.items.slice(0, SHOWN).map((item) => (
            <li key={item.key} className="flex min-w-0 gap-2">
              <code className="shrink-0 text-muted-foreground">{item.key}</code>
              <span className="min-w-0 truncate">{item.title}</span>
              {item.kind !== '' && <span className="shrink-0 text-muted-foreground">{item.kind}</span>}
            </li>
          ))}
          {result.items.length > SHOWN && (
            <li className="text-muted-foreground">and {String(result.items.length - SHOWN)} more</li>
          )}
        </ul>
      )}
      {result.invalid.length > 0 && (
        <ul aria-label="Unusable items" className="space-y-0.5 text-destructive">
          {result.invalid.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {result.logs.length > 0 && (
        <pre aria-label="Log" className="max-h-40 overflow-auto bg-muted p-2 text-2xs whitespace-pre-wrap">
          {result.logs.join('\n')}
        </pre>
      )}
    </section>
  )
}
