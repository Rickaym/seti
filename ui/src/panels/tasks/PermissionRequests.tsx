import {
  permissionRequestsSchema,
  type AnswerPermissionInput,
  type PermissionDecision,
  type PermissionRequest,
} from '@seti/shared'
import { Check, CheckCheck, Hand, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGetValid, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { refreshTasks } from '@/hooks/useTasks'
import { toolLabel } from '@/lib/tool-label'

const isPlan = (request: PermissionRequest) => request.tool_name === 'ExitPlanMode'

function planText(request: PermissionRequest): string | null {
  try {
    const input = JSON.parse(request.input) as { plan?: unknown }
    return typeof input.plan === 'string' ? input.plan : null
  } catch {
    return null
  }
}

const ACTION = 'pointer-coarse:h-11'

function Details({ request }: { request: PermissionRequest }) {
  const plan = isPlan(request) ? planText(request) : null
  return (
    <details open={plan !== null}>
      <summary className="flex min-h-6 w-fit cursor-pointer items-center text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        {plan === null ? 'Full input' : 'Plan'}
      </summary>
      <pre className="mt-1 max-h-60 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap text-muted-foreground">
        {plan ?? request.input}
      </pre>
    </details>
  )
}

/** One tool call the agent waits on, with Allow, Always and Deny. */
function PermissionCard({ request, onAnswered }: { request: PermissionRequest; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false)
  const [everyAgent, setEveryAgent] = useState(false)
  const [note, setNote] = useState('')
  const sending = useRef(false)
  const noteId = useId()
  const scopeId = useId()
  const plan = isPlan(request)
  const always = request.suggestions.length > 0

  const answer = async (decision: PermissionDecision) => {
    if (sending.current) {
      return
    }
    sending.current = true
    setBusy(true)
    const body: AnswerPermissionInput = {
      decision,
      scope: everyAgent ? 'global' : 'agent',
      ...(decision === 'deny' && note.trim() !== '' ? { message: note.trim() } : {}),
    }
    try {
      await apiPost(`/tasks/${request.task_id}/permission-requests/${request.id}`, body)
      onAnswered()
      refreshTasks()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return (
    <section
      aria-label={plan ? 'Plan approval' : `Permission request for ${toolLabel(request.tool_name)}`}
      className="mt-3 border border-warning/60 bg-warning/5 px-3 py-2.5 text-xs"
    >
      <div className="flex items-start gap-2">
        <Hand className="mt-px size-3.5 shrink-0 text-warning-text" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="font-medium text-foreground">
            {plan ? 'Approve the plan?' : `Allow ${toolLabel(request.tool_name)}?`}
          </p>
          {!plan && request.summary !== '' && (
            <code className="bg-muted px-1.5 py-1 font-mono text-2xs break-all whitespace-pre-wrap">
              {request.summary}
            </code>
          )}
          {request.reason !== null && <p className="text-muted-foreground">{request.reason}</p>}
          <Details request={request} />
          <label htmlFor={noteId} className="sr-only">
            Note for the agent if you deny
          </label>
          <Input
            id={noteId}
            value={note}
            maxLength={2000}
            placeholder="Note if you deny (optional)"
            className="h-7 text-xs"
            onChange={(e) => {
              setNote(e.target.value)
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Button size="sm" className={ACTION} disabled={busy} onClick={() => void answer('allow')}>
              <Check />
              {plan ? 'Approve' : 'Allow'}
            </Button>
            {always && (
              <Button
                size="sm"
                variant="outline"
                className={ACTION}
                disabled={busy}
                title={`Adds ${request.suggestions.join(', ')}`}
                onClick={() => void answer('always')}
              >
                <CheckCheck />
                Always
              </Button>
            )}
            <Button size="sm" variant="ghost" className={ACTION} disabled={busy} onClick={() => void answer('deny')}>
              <X />
              Deny
            </Button>
            {always && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Switch id={scopeId} size="sm" checked={everyAgent} onCheckedChange={setEveryAgent} />
                <label htmlFor={scopeId}>All agents</label>
              </span>
            )}
          </div>
          {always && (
            <p className="text-2xs text-muted-foreground">
              Always adds <span className="font-mono break-all">{request.suggestions.join(', ')}</span>
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

/**
 * The tool calls the agent waits on, read while the agent is blocked and again each time the
 * stream reports a request was made, answered or dropped.
 */
export function PermissionRequests({
  taskId,
  blocked,
  version,
}: {
  taskId: string
  /** The agent's reason line; null means nothing waits, so nothing is read. */
  blocked: string | null
  version: number
}) {
  const [pending, setPending] = useState<readonly PermissionRequest[]>([])

  useEffect(() => {
    if (blocked === null) {
      return undefined
    }
    const controller = new AbortController()
    apiGetValid(`/tasks/${taskId}/permission-requests`, permissionRequestsSchema, controller.signal)
      .then((requests) => {
        setPending(requests.filter((request) => request.state === 'pending'))
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [taskId, blocked, version])

  return (blocked === null ? [] : pending).map((request) => (
    <PermissionCard
      key={request.id}
      request={request}
      onAnswered={() => {
        setPending((prev) => prev.filter((other) => other.id !== request.id))
      }}
    />
  ))
}
