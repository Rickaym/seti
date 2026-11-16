import { Archive, RotateCw } from 'lucide-react'
import { useId } from 'react'
import { Button } from '@/components/ui/button'

const CONSEQUENCE = 'text-2xs text-muted-foreground'

interface LifecycleProps {
  busy: boolean
  onRestart: () => void
  onArchive: () => void
}

/** Restart and Archive side by side; each says what it does to the agent. */
export function LifecycleActions({ busy, onRestart, onArchive }: LifecycleProps) {
  const ids = { restart: useId(), archive: useId() }
  return (
    <div role="group" aria-label="Lifecycle" className="grid grid-cols-2 gap-x-3">
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
          className="justify-start"
          disabled={busy}
          aria-describedby={ids.archive}
          onClick={onArchive}
        >
          <Archive />
          Archive
        </Button>
        <p id={ids.archive} className={CONSEQUENCE}>
          {busy ? 'Stop the agent to archive it' : 'Leaves the list until you restore it'}
        </p>
      </div>
    </div>
  )
}
