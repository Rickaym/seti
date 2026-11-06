import { Ear } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAutoJoinStatus, useEaAutoJoin, useEaCall, useEaCallStore } from './call-context'

/** A small press in the status bar when the browser wants a gesture before the EA can listen. */
export function AutoJoinPrompt({ className }: { className?: string }) {
  const autoJoin = useEaAutoJoin()
  const store = useEaCallStore()
  const status = useAutoJoinStatus()
  const { audioBlocked } = useEaCall()
  if (status !== 'needs-gesture' && !audioBlocked) {
    return null
  }
  return (
    <button
      type="button"
      data-testid="ea-listen-prompt"
      onClick={() => {
        if (audioBlocked) {
          store.resumeAudio()
        } else {
          autoJoin.activate()
        }
      }}
      className={cn(
        'flex h-full min-w-0 cursor-pointer items-center gap-1 px-2 whitespace-nowrap text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:bg-foreground/10',
        className,
      )}
    >
      <Ear className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">Click to let the EA listen</span>
    </button>
  )
}
