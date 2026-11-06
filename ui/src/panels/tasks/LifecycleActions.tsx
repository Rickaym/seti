import { Archive, Eraser, RotateCw } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'

const CONSEQUENCE = 'text-2xs text-muted-foreground'

interface LifecycleProps {
  busy: boolean
  onRestart: () => void
  onFresh: () => void
  onArchive: () => void
}

/** Restart and Fresh side by side, Archive set apart below; each says what it does to the agent. */
export function LifecycleActions({ busy, onRestart, onFresh, onArchive }: LifecycleProps) {
  const ids = { restart: useId(), fresh: useId(), archive: useId() }
  return (
    <div role="group" aria-label="Lifecycle" className="space-y-2.5">
      <div className="grid grid-cols-2 gap-x-3">
        <div className="grid content-start gap-1">
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            aria-describedby={ids.restart}
            onClick={onRestart}
          >
            <RotateCw />
            Restart session
          </Button>
          <p id={ids.restart} className={CONSEQUENCE}>
            Keeps the conversation, reloads tools
          </p>
        </div>
        <div className="grid content-start gap-1">
          <Button
            variant="outline"
            size="sm"
            className="justify-start border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50 dark:hover:bg-destructive/20"
            aria-describedby={ids.fresh}
            onClick={onFresh}
          >
            <Eraser />
            Fresh session
          </Button>
          <p id={ids.fresh} className={CONSEQUENCE}>
            Forgets the conversation, keeps the transcript
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border pt-2.5">
        <p id={ids.archive} className={CONSEQUENCE}>
          {busy ? 'Stop the agent to archive it' : 'Leaves the list until you restore it'}
        </p>
        <Button variant="outline" size="sm" disabled={busy} aria-describedby={ids.archive} onClick={onArchive}>
          <Archive />
          Archive
        </Button>
      </div>
    </div>
  )
}
