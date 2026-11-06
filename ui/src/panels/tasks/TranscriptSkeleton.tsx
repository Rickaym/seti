import { RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useLoadingPlaceholder } from '@/hooks/useLoadingPlaceholder'

/** One placeholder block: a prompt, a reply of text lines of varied width, or a tool call row. */
type Shape = { kind: 'prompt'; width: string } | { kind: 'reply'; lines: readonly string[] } | { kind: 'tool' }

const SHAPES: readonly Shape[] = [
  { kind: 'prompt', width: 'w-2/5' },
  { kind: 'reply', lines: ['w-full', 'w-11/12', 'w-3/5'] },
  { kind: 'tool' },
  { kind: 'reply', lines: ['w-full', 'w-4/5'] },
  { kind: 'prompt', width: 'w-1/4' },
  { kind: 'reply', lines: ['w-11/12', 'w-full', 'w-5/6', 'w-2/5'] },
  { kind: 'tool' },
  { kind: 'reply', lines: ['w-3/4'] },
]

function Block({ shape }: { shape: Shape }) {
  if (shape.kind === 'prompt') {
    return (
      <div className="border border-primary/20 bg-primary/5 px-3 py-2.5">
        <Skeleton className={`h-4 ${shape.width}`} />
      </div>
    )
  }
  if (shape.kind === 'tool') {
    return (
      <div className="flex items-center gap-2 border-l-2 border-border bg-muted/40 px-2 py-2">
        <Skeleton className="size-3" />
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 w-full max-w-64" />
      </div>
    )
  }
  return (
    <div className="space-y-2 py-0.5">
      {shape.lines.map((width, index) => (
        <Skeleton key={`${width}-${String(index)}`} className={`h-3.5 ${width}`} />
      ))}
    </div>
  )
}

/** Message-shaped placeholders in the transcript's own spacing, so rows replace them in place. */
function TranscriptSkeleton({ slow = false }: { slow?: boolean }) {
  return (
    <div role="status" aria-label="Loading transcript" aria-busy="true" className="space-y-3">
      {SHAPES.map((shape, index) => (
        <Block key={`${shape.kind}-${String(index)}`} shape={shape} />
      ))}
      {slow && <p className="text-xs text-muted-foreground">Still loading... (slow network)</p>}
    </div>
  )
}

export type Placeholder = 'skeleton' | 'slow' | 'retry'

/** The skeleton while rows load, or a retry once loading them failed. */
export function TranscriptPlaceholder({ shown, onRetry }: { shown: Placeholder; onRetry?: (() => void) | undefined }) {
  if (shown !== 'retry') {
    return <TranscriptSkeleton slow={shown === 'slow'} />
  }
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
      <span>Could not load the transcript.</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RotateCw />
        Retry
      </Button>
    </div>
  )
}

/** A whole detail pane still waiting for its agent: header bars over the transcript skeleton. */
export function DetailSkeleton() {
  const { skeleton, slow } = useLoadingPlaceholder(true)
  if (!skeleton) {
    return null
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border px-5 py-3 max-md:px-3 max-md:py-2">
        <Skeleton className="h-6 w-64 max-w-3/5" />
        <Skeleton className="h-3 w-40 max-w-2/5" />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-5 py-4 max-md:px-3 max-md:py-3">
        <TranscriptSkeleton slow={slow} />
      </div>
    </div>
  )
}
