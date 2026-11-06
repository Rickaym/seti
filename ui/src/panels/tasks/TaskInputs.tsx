import { INPUT_MODES, type InputMode, type InputPause, type MessageRow, type Task } from '@seti/shared'
import { Forward, Hourglass, Inbox, LoaderCircle, Pause, X, type LucideIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet, apiPatch, apiPost, errorText } from '@/api'
import { Hint } from '@/components/Hint'
import { InfoTip } from '@/components/InfoTip'
import { clockTime } from '@/components/account/format'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm-context'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { dismissQuestion, waitingReason, type WaitingKind } from '@/lib/queued-inputs'
import { queuedInputs } from '@/lib/transcript'
import { cn } from '@/lib/utils'

const MODE_LABELS: Record<InputMode, string> = {
  wake: 'Wake the agent',
  queue: 'Wait for my message',
  off: 'Off',
}

/** What the task does with PR updates and channel events: start a turn, hold them, or ignore them. */
export function InputModeSelect({ task, onChanged }: { task: Task; onChanged: () => void }) {
  const change = async (mode: string) => {
    try {
      await apiPatch<Task>(`/tasks/${task.id}`, { input_mode: mode })
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    }
  }
  return (
    <Select value={task.input_mode} onValueChange={(mode) => void change(mode)}>
      <SelectTrigger aria-label="Updates" size="sm" className="h-6 gap-1 px-1.5 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INPUT_MODES.map((mode) => (
          <SelectItem key={mode} value={mode} className="text-xs">
            {MODE_LABELS[mode]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** When a wake task hands its waiting updates over by itself after a burst of automatic turns. */
function usePausedUntil(taskId: string, asks: boolean, count: number): string | null {
  const [pausedUntil, setPausedUntil] = useState<string | null>(null)
  useEffect(() => {
    if (!asks) {
      return
    }
    let current = true
    apiGet<InputPause>(`/tasks/${taskId}/inputs`)
      .then((pause) => {
        if (current) {
          setPausedUntil(pause.paused_until)
        }
      })
      .catch((e: unknown) => toast.error(errorText(e)))
    return () => {
      current = false
    }
  }, [taskId, asks, count])
  return pausedUntil
}

/** Held updates read as a nudge; ones on their way by themselves stay quiet. */
const WAITING_STYLES: Record<WaitingKind, { icon: LucideIcon; bar: string; iconClass: string }> = {
  message: { icon: Inbox, bar: 'bg-warning/10', iconClass: 'text-warning-text' },
  paused: { icon: Pause, bar: 'bg-warning/10', iconClass: 'text-warning-text' },
  turn: { icon: Hourglass, bar: 'bg-muted/40 text-muted-foreground', iconClass: '' },
  soon: { icon: LoaderCircle, bar: 'bg-muted/40 text-muted-foreground', iconClass: 'motion-safe:animate-spin' },
}

/** Updates the agent has not read, with a way to hand them over without writing a message. */
export function QueuedInputs({
  task,
  messages,
  running,
}: {
  task: Task
  messages: readonly MessageRow[]
  running: boolean
}) {
  const queued = useMemo(() => queuedInputs(messages), [messages])
  const count = queued.length
  const [sending, setSending] = useState(false)
  const confirm = useConfirm()
  const pausedUntil = usePausedUntil(task.id, count > 0 && task.input_mode === 'wake' && !running, count)
  const newest = queued.at(-1)
  if (newest === undefined) {
    return null
  }
  const act = async (path: string, body?: unknown) => {
    setSending(true)
    try {
      await apiPost(`/tasks/${task.id}/inputs/${path}`, body)
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      setSending(false)
    }
  }
  const inputs = queued.map((row) => row.payload)
  const dismiss = async () => {
    if (inputs.length > 1) {
      const message = dismissQuestion(inputs)
      if (!(await confirm({ title: 'Dismiss updates', message, confirmLabel: 'Dismiss', variant: 'destructive' }))) {
        return
      }
    }
    await act('dismiss', { up_to: newest.id })
  }
  const noun = count === 1 ? 'update waits' : 'updates wait'
  const { kind, text } = waitingReason(task.input_mode, running, pausedUntil, inputs)
  const style = WAITING_STYLES[kind]
  const Icon = style.icon
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2 border-t border-border px-5 py-1.5 text-xs', style.bar)}
      data-testid="queued-inputs"
      data-waiting={kind}
    >
      <InfoTip
        className="min-w-0 gap-1.5 text-current hover:text-current"
        text={`${String(count)} ${noun} for the agent. ${text}`}
      >
        <Icon className={cn('size-3.5 shrink-0', style.iconClass)} aria-hidden />
        <span className="truncate">
          {count} queued
          {kind === 'paused' && pausedUntil !== null && (
            <span className="text-muted-foreground"> until {clockTime(pausedUntil)}</span>
          )}
        </span>
      </InfoTip>
      <span className="flex-1" />
      <Hint text="Give the waiting updates to the agent now, without writing a message" side="top">
        <Button size="xs" variant="outline" disabled={sending} onClick={() => void act('deliver')}>
          <Forward />
          Hand over
        </Button>
      </Hint>
      <Hint text="Dismiss these updates; the agent never gets them" side="top">
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" disabled={sending} onClick={() => void dismiss()}>
          <X />
        </Button>
      </Hint>
    </div>
  )
}
