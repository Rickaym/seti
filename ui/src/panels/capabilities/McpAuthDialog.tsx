import { callbackUrlIssue, type McpAuthDone, type McpAuthStart, type McpSignInInput } from '@seti/shared'
import { Check, CheckCircle2, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { apiDelete, apiPost, errorText } from '@/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

type Step =
  | { kind: 'starting' }
  | { kind: 'failed'; error: string }
  | { kind: 'waiting'; session: McpAuthStart; error: string; submitting: boolean }
  | { kind: 'external'; url: string }
  | { kind: 'done' }

const cancelSession = (id: string) => {
  apiDelete(`/mcp/auth/${id}`).catch(() => undefined)
}

function useSignIn(serverName: string, scope: McpSignInInput, onDone: () => void) {
  const [step, setStep] = useState<Step>({ kind: 'starting' })
  const open = useRef<string | null>(null)

  useEffect(() => {
    let stale = false
    const body: McpSignInInput = {
      ...(scope.repo_id === undefined ? {} : { repo_id: scope.repo_id }),
      ...(scope.task_id === undefined ? {} : { task_id: scope.task_id }),
    }
    apiPost<McpAuthStart>(`/mcp/${encodeURIComponent(serverName)}/auth/start`, body)
      .then((session) => {
        if (stale) {
          cancelSession(session.session_id)
          return
        }
        if (!session.callback_expected) {
          setStep({ kind: 'external', url: session.authorization_url })
          return
        }
        open.current = session.session_id
        setStep({ kind: 'waiting', session, error: '', submitting: false })
      })
      .catch((e: unknown) => {
        if (!stale) {
          setStep({ kind: 'failed', error: errorText(e) })
        }
      })
    return () => {
      stale = true
      if (open.current !== null) {
        cancelSession(open.current)
        open.current = null
      }
    }
  }, [serverName, scope.repo_id, scope.task_id])

  const complete = async (session: McpAuthStart, callbackUrl: string) => {
    setStep({ kind: 'waiting', session, error: '', submitting: true })
    try {
      await apiPost<McpAuthDone>(`/mcp/auth/${session.session_id}/complete`, { callback_url: callbackUrl })
      open.current = null
      setStep({ kind: 'done' })
      onDone()
    } catch (e) {
      setStep({ kind: 'waiting', session, error: errorText(e), submitting: false })
    }
  }

  return { step, complete }
}

function PasteStep({
  session,
  error,
  submitting,
  onComplete,
}: {
  session: McpAuthStart
  error: string
  submitting: boolean
  onComplete: (callbackUrl: string) => void
}) {
  const [callback, setCallback] = useState('')
  const issue = callback.trim() === '' ? null : callbackUrlIssue(callback.trim())
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="font-medium">1. Approve access</p>
        <Button asChild variant="outline" size="sm">
          <a href={session.authorization_url} target="_blank" rel="noreferrer noopener">
            <ExternalLink />
            Sign in
          </a>
        </Button>
      </div>
      <div className="space-y-2">
        <p className="font-medium">2. Paste the address you land on</p>
        <p className="text-muted-foreground">
          After you approve, the browser goes to a <code>http://localhost:...</code> page that fails to load. That is
          expected. Copy the full address from the address bar and paste it here.
        </p>
        <Input
          aria-label="Callback address"
          aria-invalid={issue !== null || error !== ''}
          placeholder="http://localhost:12345/callback?code=...&state=..."
          value={callback}
          onChange={(e) => {
            setCallback(e.target.value)
          }}
        />
        {(issue ?? error) !== '' && <p className="break-words text-destructive">{issue ?? error}</p>}
      </div>
      <DialogFooter>
        <Button
          type="button"
          disabled={submitting || callback.trim() === '' || issue !== null}
          onClick={() => {
            onComplete(callback.trim())
          }}
        >
          {submitting ? <Loader2 className="animate-spin" /> : <Check />}
          Finish
        </Button>
      </DialogFooter>
    </div>
  )
}

function ExternalStep({ url, onDone }: { url: string; onDone: () => void }) {
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        This is a claude.ai connector. Approve it on claude.ai; there is nothing to paste back. Refresh once you are
        done.
      </p>
      <Button asChild variant="outline" size="sm">
        <a href={url} target="_blank" rel="noreferrer noopener">
          <ExternalLink />
          Open claude.ai
        </a>
      </Button>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          <RefreshCw />
          Refresh
        </Button>
      </DialogFooter>
    </div>
  )
}

/** A sign-in from an agent's access names its task, whose session decides whether one is due. */
export function McpAuthDialog({
  serverName,
  repoId,
  taskId,
  onClose,
  onDone,
}: {
  serverName: string
  repoId: string | undefined
  taskId?: string
  onClose: () => void
  onDone: () => void
}) {
  const { step, complete } = useSignIn(serverName, { repo_id: repoId, task_id: taskId }, onDone)
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to {serverName}</DialogTitle>
        </DialogHeader>
        {step.kind === 'starting' && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Starting the sign-in...
          </p>
        )}
        {step.kind === 'failed' && <p className="break-words text-destructive">{step.error}</p>}
        {step.kind === 'waiting' && (
          <PasteStep
            session={step.session}
            error={step.error}
            submitting={step.submitting}
            onComplete={(callbackUrl) => void complete(step.session, callbackUrl)}
          />
        )}
        {step.kind === 'external' && (
          <ExternalStep
            url={step.url}
            onDone={() => {
              onDone()
              onClose()
            }}
          />
        )}
        {step.kind === 'done' && (
          <>
            <p className="flex items-center gap-2">
              <CheckCircle2 className="size-4 text-success" />
              Signed in. Capabilities are refreshing and the server should show as connected shortly.
            </p>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                <Check />
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
