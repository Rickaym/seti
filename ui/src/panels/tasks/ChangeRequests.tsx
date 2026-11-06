import {
  answerChangeInput,
  changeRequestsSchema,
  hostEntry,
  type AnswerChangeInput,
  type ChangeRequest,
  type HostScope,
} from '@seti/shared'
import { Check, Eye, EyeOff, Globe, KeyRound, Plug, TriangleAlert, User, Users, X, type LucideIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGetValid, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { refreshTasks } from '@/hooks/useTasks'

const ACTION = 'pointer-coarse:h-11'
const PRESSED = 'aria-pressed:border-primary aria-pressed:bg-primary/10 aria-pressed:text-primary'

const KIND_ICONS: Record<ChangeRequest['change']['kind'], LucideIcon> = {
  allow_host: Globe,
  api_key: KeyRound,
  mcp_server: Plug,
}

function title(request: ChangeRequest, scope: HostScope): string {
  const { change } = request
  switch (change.kind) {
    case 'allow_host':
      return `Let ${scope === 'all' ? 'every agent' : 'this agent'} reach ${hostEntry(change)}?`
    case 'api_key':
      return `Add the connection ${change.env}?`
    case 'mcp_server':
      return `Turn on the MCP server ${change.server}?`
  }
}

/** The line the change adds and the list it joins. */
function diffOf(change: ChangeRequest['change'], scope: HostScope): [string, string] {
  switch (change.kind) {
    case 'allow_host':
      return [hostEntry(change), `Network allowlist of ${scope === 'all' ? 'every agent' : 'this agent'}`]
    case 'api_key':
      return [`${change.env} for ${change.hosts.join(', ')}`, "This agent's credential"]
    case 'mcp_server':
      return [change.server, 'MCP servers of this agent']
  }
}

/** The exact change, as a line added to the list it joins. */
function Diff({ request, scope }: { request: ChangeRequest; scope: HostScope }) {
  const [line, where] = diffOf(request.change, scope)
  return (
    <div className="flex flex-col gap-0.5">
      <code className="bg-muted px-1.5 py-1 font-mono text-2xs break-all whitespace-pre-wrap">+ {line}</code>
      <span className="text-2xs text-muted-foreground">{where}</span>
    </div>
  )
}

function ScopeChoice({ scope, onChange }: { scope: HostScope; onChange: (scope: HostScope) => void }) {
  const options: [HostScope, LucideIcon, string][] = [
    ['agent', User, 'This agent'],
    ['all', Users, 'All agents'],
  ]
  return (
    <div role="group" aria-label="Who reaches it" className="flex gap-1.5">
      {options.map(([value, Icon, label]) => (
        <Button
          key={value}
          size="sm"
          variant="outline"
          aria-pressed={scope === value}
          className={`${ACTION} ${PRESSED}`}
          onClick={() => {
            onChange(value)
          }}
        >
          <Icon />
          {label}
        </Button>
      ))}
    </div>
  )
}

/**
 * A write-only box for the key a connection request needs, masked unless the user shows it. The
 * key goes only to the user's own Allow; leaving it empty adds the connection without its key.
 */
function KeyField({
  env,
  value,
  disabled,
  onChange,
}: {
  env: string
  value: string
  disabled: boolean
  onChange: (value: string) => void
}) {
  const [shown, setShown] = useState(false)
  const label = shown ? 'Hide key' : 'Show key'
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`Key for ${env}`}
          type={shown ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          className={`${ACTION} font-mono`}
          placeholder="Paste the key"
          value={value}
          onChange={(event) => {
            onChange(event.target.value)
          }}
        />
        <Button
          size="icon"
          variant="outline"
          aria-label={label}
          title={label}
          aria-pressed={shown}
          className="pointer-coarse:size-11"
          onClick={() => {
            setShown((prev) => !prev)
          }}
        >
          {shown ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      <span className="text-2xs text-muted-foreground">Optional; you can paste it later in Connections</span>
    </div>
  )
}

/** One change an agent asked for, with the exact change, its reason, and Allow or Deny. */
function ChangeCard({ request, onAnswered }: { request: ChangeRequest; onAnswered: () => void }) {
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<HostScope>('agent')
  const [key, setKey] = useState('')
  const sending = useRef(false)
  const Icon = KIND_ICONS[request.change.kind]

  const answer = async (input: AnswerChangeInput) => {
    const parsed = answerChangeInput.safeParse(input)
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Check the key')
      return
    }
    if (sending.current) {
      return
    }
    sending.current = true
    setBusy(true)
    try {
      await apiPost(`/tasks/${request.task_id}/change-requests/${request.id}`, parsed.data)
      onAnswered()
      refreshTasks()
    } catch (e) {
      toast.error(errorText(e))
    } finally {
      sending.current = false
      setKey('')
      setBusy(false)
    }
  }

  const host = request.change.kind === 'allow_host'
  const keyed = request.change.kind === 'api_key'
  const allow = (): AnswerChangeInput =>
    keyed && key !== '' ? { decision: 'allow', scope, value: key } : { decision: 'allow', scope }
  return (
    <section
      aria-label={`Change request: ${title(request, scope)}`}
      className="mt-3 border border-warning/60 bg-warning/5 px-3 py-2.5 text-xs"
    >
      <div className="flex items-start gap-2">
        <Icon className="mt-px size-3.5 shrink-0 text-warning-text" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="font-medium text-foreground">{title(request, scope)}</p>
          <p className="text-muted-foreground">{request.reason}</p>
          <Diff request={request} scope={scope} />
          {request.flags.map((flag) => (
            <p key={flag} className="flex items-center gap-1 text-warning-text">
              <TriangleAlert className="size-3 shrink-0" aria-hidden />
              {flag}
            </p>
          ))}
          {host && <ScopeChoice scope={scope} onChange={setScope} />}
          {request.change.kind === 'api_key' && (
            <KeyField env={request.change.env} value={key} disabled={busy} onChange={setKey} />
          )}
          <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
            <Button size="sm" className={ACTION} disabled={busy} onClick={() => void answer(allow())}>
              <Check />
              Allow
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className={ACTION}
              disabled={busy}
              onClick={() => void answer({ decision: 'deny' })}
            >
              <X />
              Deny
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * The changes the agent asked the user for, read while the agent is blocked and again each time
 * its reason line or permission requests change.
 */
export function ChangeRequests({
  taskId,
  blocked,
  version,
}: {
  taskId: string
  blocked: string | null
  version: number
}) {
  const [pending, setPending] = useState<readonly ChangeRequest[]>([])

  useEffect(() => {
    if (blocked === null) {
      return undefined
    }
    const controller = new AbortController()
    apiGetValid(`/tasks/${taskId}/change-requests`, changeRequestsSchema, controller.signal)
      .then((requests) => {
        setPending(requests.filter((request) => request.state === 'pending'))
      })
      .catch(() => undefined)
    return () => {
      controller.abort()
    }
  }, [taskId, blocked, version])

  return (blocked === null ? [] : pending).map((request) => (
    <ChangeCard
      key={request.id}
      request={request}
      onAnswered={() => {
        setPending((prev) => prev.filter((other) => other.id !== request.id))
      }}
    />
  ))
}
