import { Brain } from 'lucide-react'
import type { LiveExchange } from './rows'

/** What a running think is doing, shown under the transcript while the typed reply waits on it. */
export function ThinkingLine({ live }: { live: LiveExchange | null }) {
  const text = live?.thinking
  if (text === undefined || text === null) {
    return null
  }
  return (
    <div className="shrink-0 px-5 pt-2 max-md:px-3">
      <p
        role="status"
        aria-label="Thinking"
        title={text}
        className="mx-auto flex w-full max-w-3xl items-center gap-2 text-xs text-muted-foreground"
      >
        <Brain className="size-3.5 shrink-0 animate-pulse text-primary" aria-hidden="true" />
        <span className="shrink-0 font-semibold text-foreground">Thinking</span>
        <span className="min-w-0 flex-1 truncate">{text}</span>
      </p>
    </div>
  )
}
