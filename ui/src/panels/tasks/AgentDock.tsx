import type { Task } from '@seti/shared'
import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { closeAgentDock, useAgentDock, type AgentDock } from '@/panels/tasks/agent-docks'

/**
 * Esc inside the dock, or with focus nowhere in particular, closes it before the agent view
 * takes Esc to stop the agent.
 */
function useEscapeToClose(onClose: () => void) {
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      const el = panel.current
      const target = e.target instanceof Node ? e.target : null
      const ours = target === document.body || (el !== null && target !== null && el.contains(target))
      if (e.key === 'Escape' && !e.defaultPrevented && ours) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [onClose])
  return panel
}

interface DockFrameProps {
  task: Pick<Task, 'id' | 'title'>
  dock: AgentDock
  focus: number
  sheet: boolean
  onClose: () => void
}

/** Seti's frame of a mod's dock: its header with a close button, around the mod's view. */
function DockFrame({ task, dock, focus, sheet, onClose }: DockFrameProps) {
  const panel = useEscapeToClose(onClose)
  const { icon: Icon, view: View } = dock
  return (
    <div
      ref={panel}
      role="dialog"
      aria-label={dock.title}
      tabIndex={-1}
      className={cn(
        'absolute z-30 flex flex-col border-border bg-popover outline-none text-popover-foreground shadow-lg',
        sheet
          ? 'inset-x-0 bottom-0 max-h-[85%] border-t pb-[env(safe-area-inset-bottom)]'
          : 'top-2 right-2 max-h-[min(40rem,calc(100%-7rem))] w-[min(28rem,calc(100%-1rem))] border',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border py-1 pr-1 pl-3">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{dock.title}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{dock.description}</span>
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${dock.title}`} onClick={onClose}>
          <X />
        </Button>
      </div>
      <ErrorBoundary name={dock.title}>
        <View agent={{ id: task.id, title: task.title }} focus={focus} close={onClose} />
      </ErrorBoundary>
    </div>
  )
}

interface AgentDockAreaProps {
  task: Pick<Task, 'id' | 'title'>
  /** A bottom sheet over the agent on phones; a dock over its transcript elsewhere. */
  sheet: boolean
  children: ReactNode
}

/** The agent's chat with a mod's dock over it while one is open; closing it is the mod's cue. */
export function AgentDockArea({ task, sheet, children }: AgentDockAreaProps) {
  const open = useAgentDock(task.id)
  const close = useCallback(() => {
    closeAgentDock(task.id)
  }, [task.id])
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {children}
      {open !== null && sheet && <div aria-hidden className="absolute inset-0 z-30 bg-overlay" onClick={close} />}
      {open !== null && <DockFrame task={task} dock={open.dock} focus={open.focus} sheet={sheet} onClose={close} />}
    </div>
  )
}
