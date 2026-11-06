import { LoaderCircle } from 'lucide-react'
import { useNow } from '@/hooks/useNow'
import { elapsedLabel } from '@/lib/time'

/** The compaction Claude Code is running, which sends nothing else until it finishes. */
export function CompactingNote({ since }: { since: string }) {
  const now = useNow(true)
  return (
    <div
      role="status"
      aria-label="Compacting"
      className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
    >
      <LoaderCircle className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
      <span className="font-semibold text-foreground">Compacting the conversation</span>
      <span className="tabular-nums">{elapsedLabel(now - Date.parse(since))}</span>
      <span>Claude Code is summarising earlier messages, which can take a few minutes.</span>
    </div>
  )
}
