import type { Task } from '@seti/shared'
import { RotateCcw, RotateCw, TriangleAlert } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { apiPost, errorText } from '@/api'
import { SettingsLink } from '@/components/SettingsLink'
import { resetClock } from '@/components/account/format'
import { useCommands } from '@/components/palette/useCommands'
import { Button } from '@/components/ui/button'
import { useAccount } from '@/hooks/useAccount'
import { useMinute } from '@/hooks/useMinute'
import { classifyFailure, INTERRUPTED, rateLimitResetAt, type Failure } from '@/lib/failure'
import { useRestartAction } from '@/panels/tasks/useSessionRestart'

const ACCOUNT_KINDS: ReadonlySet<Failure['kind']> = new Set(['auth', 'billing'])

function RawText({ raw }: { raw: string }) {
  return (
    <details>
      <summary className="flex min-h-6 w-fit cursor-pointer items-center text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        Error details
      </summary>
      <pre className="mt-1 max-h-40 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground">
        {raw}
      </pre>
    </details>
  )
}

/** A failed turn in a transcript: the plain cause on one line, the raw error folded under it. */
export function FailureLine({ raw }: { raw: string }) {
  const failure = classifyFailure(raw)
  return (
    <details className="text-xs" data-failure={failure.kind}>
      <summary className="flex min-h-6 w-fit cursor-pointer items-center gap-2 text-destructive pointer-coarse:min-h-11">
        <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
        <span>{failure.title}</span>
        <span className="text-muted-foreground">Details</span>
      </summary>
      <pre className="mt-1 ml-5.5 max-h-40 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground">
        {raw}
      </pre>
    </details>
  )
}

function useResetLabel(failure: Failure): string | null {
  const { data } = useAccount()
  const now = useMinute()
  if (failure.kind !== 'rate_limit') {
    return null
  }
  const at = rateLimitResetAt(data, now)
  if (at === null) {
    return null
  }
  const when = new Date(at)
  return `Resets ${resetClock(when, when.getTime() - now)}.`
}

function Notice({ failure, raw, children }: { failure: Failure; raw: string | null; children: ReactNode }) {
  const reset = useResetLabel(failure)
  return (
    <section
      aria-label="Turn failed"
      data-failure={failure.kind}
      className="mt-3 border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-xs"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="font-medium text-foreground">
            {failure.title}
            {reset !== null && <span className="ml-1.5 font-normal tabular-nums">{reset}</span>}
          </p>
          {failure.hint !== null && <p className="text-muted-foreground">{failure.hint}</p>}
          {raw !== null && <RawText raw={raw} />}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            {children}
            {ACCOUNT_KINDS.has(failure.kind) && <SettingsLink page="account">Open Account settings</SettingsLink>}
          </div>
        </div>
      </div>
    </section>
  )
}

/** Why the last turn failed or stopped, with Retry turn and Restart session. */
export function TaskFailure({
  task,
  status,
  onChanged,
}: {
  task: Task
  status: 'error' | 'interrupted'
  onChanged: () => void
}) {
  const [retrying, setRetrying] = useState(false)
  const sending = useRef(false)
  const restart = useRestartAction(task, false, onChanged)
  const failure = status === 'interrupted' ? INTERRUPTED : classifyFailure(task.last_error ?? '')
  const raw = status === 'interrupted' ? null : task.last_error

  const retry = async () => {
    if (sending.current) {
      return
    }
    sending.current = true
    setRetrying(true)
    try {
      await apiPost(`/tasks/${task.id}/retry`)
      onChanged()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      sending.current = false
      setRetrying(false)
    }
  }

  useCommands([
    {
      id: 'agent.retry-turn',
      title: 'Retry turn',
      detail: task.title,
      icon: RotateCcw,
      group: 'Current agent',
      keywords: 'resend again failed error rate limit',
      when: (context) => context.agent?.id === task.id,
      run: () => void retry(),
    },
  ])

  return (
    <Notice failure={failure} raw={raw}>
      <Button size="xs" variant="outline" disabled={retrying} onClick={() => void retry()}>
        <RotateCcw />
        Retry turn
      </Button>
      <Button size="xs" variant="ghost" onClick={() => void restart(false)}>
        <RotateCw />
        Restart session
      </Button>
    </Notice>
  )
}
