import type { AccessItem, McpSessionState } from '@seti/shared'
import { KeyRound } from 'lucide-react'
import { Hint } from '@/components/Hint'
import { Button } from '@/components/ui/button'
import { mcpFailureHint } from '@/lib/failure'
import { cn } from '@/lib/utils'
import { mcpBroken } from './access'

const STYLE: Record<McpSessionState['status'], { label: string; className: string }> = {
  connected: { label: 'connected', className: 'bg-success/20 text-foreground' },
  'needs-auth': { label: 'needs auth', className: 'bg-warning/30 text-foreground' },
  failed: { label: 'failed', className: 'bg-destructive/20 text-destructive' },
  pending: { label: 'pending', className: 'bg-muted text-muted-foreground' },
  disabled: { label: 'disabled', className: 'bg-muted text-muted-foreground' },
  not_loaded: { label: 'not loaded', className: 'bg-destructive/20 text-destructive' },
}

/** Why the server does not work: a plain hint for a failure, the raw error folded under it. */
function Reason({ state, broken }: { state: McpSessionState; broken: boolean }) {
  const hint = mcpFailureHint(state)
  const raw = state.reason
  if (hint === null) {
    return raw === null ? null : (
      <span className={cn('min-w-0 break-words', broken ? 'text-destructive' : 'text-muted-foreground')}>{raw}</span>
    )
  }
  if (raw === null || state.status === 'needs-auth') {
    return <span className="min-w-0 break-words text-destructive">{hint}</span>
  }
  return (
    <details className="min-w-0">
      <summary className="cursor-pointer break-words text-destructive">{hint}</summary>
      <span className="mt-0.5 block font-mono break-all text-muted-foreground">{raw}</span>
    </details>
  )
}

/** How the agent's latest session has an MCP server, why it does not work, and a sign-in. */
export function McpSessionNote({ item, onSignIn }: { item: AccessItem; onSignIn?: (item: AccessItem) => void }) {
  const state = item.session
  if (state === null) {
    return null
  }
  const style = STYLE[state.status]
  return (
    <div className="flex min-w-0 items-start gap-1.5 pt-0.5 text-2xs">
      <Hint text={`In the latest session, ${new Date(state.at).toLocaleString()}`}>
        <span
          aria-label={`Latest session: ${style.label}`}
          className={cn('shrink-0 px-1 font-semibold whitespace-nowrap uppercase', style.className)}
        >
          {style.label}
        </span>
      </Hint>
      <Reason state={state} broken={mcpBroken(item)} />
      {onSignIn !== undefined && state.sign_in === 'required' && (
        <Button
          type="button"
          size="xs"
          className="-my-0.5 shrink-0"
          onClick={() => {
            onSignIn(item)
          }}
        >
          <KeyRound />
          Sign in
        </Button>
      )}
      {onSignIn !== undefined && state.sign_in === 'again' && (
        <Hint text={`Sign in to ${item.name} again`}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Sign in to ${item.name} again`}
            className="-my-0.5 shrink-0 text-muted-foreground"
            onClick={() => {
              onSignIn(item)
            }}
          >
            <KeyRound />
          </Button>
        </Hint>
      )}
    </div>
  )
}
