import type { MessageRow, Task } from '@seti/shared'
import { LoaderCircle } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'
import { QuestionCall } from '@/panels/questions/QuestionCall'
import { ChangeRequests } from '@/panels/tasks/ChangeRequests'
import { TaskFailure } from '@/panels/tasks/FailureNotice'
import { PermissionRequests } from '@/panels/tasks/PermissionRequests'
import { AgentText } from '@/panels/tasks/Transcript'
import type { TranscriptLoad } from '@/panels/tasks/TranscriptPane'
import { TranscriptPlaceholder } from '@/panels/tasks/TranscriptSkeleton'
import { calmOutcome } from '@/panels/tasks/calm-outcome'

/**
 * What needs the user, in full: using it keeps the view calm, so a press on Allow lands on the
 * button it aimed at, and leaving it lets the view open.
 */
function Needs({ onHold, children }: { onHold: (held: boolean) => void; children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null)
  const pressed = useRef(false)
  const settle = useCallback(() => {
    if (!pressed.current && region.current?.contains(document.activeElement) !== true) {
      onHold(false)
    }
  }, [onHold])
  useEffect(() => {
    const release = () => {
      setTimeout(() => {
        pressed.current = false
        settle()
      })
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', release)
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [settle])
  // A card that goes once answered takes focus with it, which no blur reports.
  useLayoutEffect(settle)
  const onBlur = (event: FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      onHold(false)
    }
  }
  return (
    <div
      ref={region}
      data-testid="calm-needs"
      className="shrink-0 space-y-2 empty:hidden *:mt-0!"
      onPointerDownCapture={() => {
        pressed.current = true
        onHold(true)
      }}
      onFocusCapture={() => {
        onHold(true)
      }}
      onBlurCapture={onBlur}
    >
      {children}
    </div>
  )
}

/** The latest message from its first line, cut after about six lines with a quiet "more". */
function Outcome({ text, stale }: { text: string; stale: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [cut, setCut] = useState(false)
  useEffect(() => {
    const el = box.current
    const inner = el?.firstElementChild
    if (!el || !inner) {
      return undefined
    }
    const observer = new ResizeObserver(() => {
      setCut(el.scrollHeight > el.clientHeight + 1)
    })
    observer.observe(el)
    observer.observe(inner)
    return () => {
      observer.disconnect()
    }
  }, [])
  return (
    <div
      ref={box}
      data-testid="calm-outcome"
      data-stale={stale}
      className="relative max-h-36 min-h-0 flex-1 overflow-hidden"
    >
      <div className={cn(stale && 'opacity-60')}>
        <AgentText text={text} />
      </div>
      {cut && (
        <p className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-linear-to-t from-background from-40% to-transparent pt-8 text-2xs text-muted-foreground">
          <span data-testid="calm-more" className="bg-background pl-2">
            more
          </span>
        </p>
      )}
    </div>
  )
}

interface CalmBodyProps {
  task: Task
  status: Task['status']
  /** Every loaded row, which the latest message and the open question are read from. */
  messages: readonly MessageRow[]
  /** Changes each time the agent's permission requests may have changed. */
  permissions: number
  load: TranscriptLoad
  /** Keeps the view calm while what needs the user is in use. */
  onHold: (held: boolean) => void
  onChanged: () => void
}

/** A calm agent view's body: what needs the user in full, then the agent's latest message. */
export function CalmBody({ task, status, messages, permissions, load, onHold, onChanged }: CalmBodyProps) {
  const running = status === 'running'
  const shown = useMemo(
    () => calmOutcome(messages, { running, blocked: task.blocked !== null }),
    [messages, running, task.blocked],
  )
  if (load.pending) {
    return (
      <div className="min-h-0 flex-1 overflow-hidden bg-background px-3 py-2">
        {load.failed && <TranscriptPlaceholder shown="retry" onRetry={load.onRetry} />}
      </div>
    )
  }
  return (
    <div data-testid="calm-body" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-background px-3 py-2">
      <Needs onHold={onHold}>
        <PermissionRequests taskId={task.id} blocked={task.blocked} version={permissions} />
        <ChangeRequests taskId={task.id} blocked={task.blocked} version={permissions} />
        {(status === 'error' || status === 'interrupted') && (
          <TaskFailure task={task} status={status} onChanged={onChanged} />
        )}
        {shown.question !== null && <QuestionCall taskId={task.id} block={shown.question} done={false} />}
      </Needs>
      {shown.working !== null && (
        <p data-testid="calm-working" className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-3 shrink-0 animate-spin" />
          <span className="min-w-0 truncate">{shown.working}</span>
        </p>
      )}
      {shown.text === null ? (
        shown.working === null &&
        shown.question === null && <p className="text-xs text-muted-foreground">No message from this agent yet.</p>
      ) : (
        <Outcome text={shown.text} stale={shown.stale} />
      )}
    </div>
  )
}
