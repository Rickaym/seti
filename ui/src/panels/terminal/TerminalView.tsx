import { lazy, Suspense } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import type { TerminalSessionProps } from './TerminalSession'

const TerminalSession = lazy(async () =>
  import('@/panels/terminal/TerminalSession').then((m) => ({ default: m.TerminalSession })),
)

/** A terminal's shell, loading xterm on first use; a layout and the alone view both show it. */
export function TerminalView(props: TerminalSessionProps) {
  return (
    <ErrorBoundary name="Terminal" resetKey={props.tab.id}>
      <Suspense fallback={<p className="p-4 text-sm text-muted-foreground">Loading terminal...</p>}>
        <TerminalSession {...props} />
      </Suspense>
    </ErrorBoundary>
  )
}
