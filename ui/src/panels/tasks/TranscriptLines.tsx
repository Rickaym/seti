import type { SDKCompactBoundaryMessage, SDKResultMessage, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk'
import { compactedAt, modelLabel, turnCostOf } from '@seti/shared'
import { FoldVertical, Play, Terminal } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { CopyIconButton } from '@/components/CopyButton'
import { usd } from '@/lib/money'
import { DOT, lastSegment, permissionLabel, plural, turnOutcome } from '@/lib/session-labels'
import { elapsedLabel } from '@/lib/time'
import { cn } from '@/lib/utils'

export function Line({
  icon: Icon,
  error = false,
  action,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  error?: boolean
  /** A button at the end of the line, which must not make the line taller. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={cn('flex items-center gap-2 text-xs text-muted-foreground', error && 'text-destructive')}>
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
      {action}
    </div>
  )
}

const NONE = '-'

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground/80">{label}</dt>
      <dd className="min-w-0 break-all text-foreground/80">{children}</dd>
    </>
  )
}

/** Everything the session start reported, for the expanded init line. */
function SessionFacts({ message }: { message: SDKSystemMessage }) {
  const errors = message.plugin_errors ?? []
  return (
    <dl className="mt-1 ml-5.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 bg-muted p-2 text-2xs">
      <Fact label="Session">
        <span className="font-mono">{message.session_id}</span>
      </Fact>
      <Fact label="Model">{message.model}</Fact>
      <Fact label="Permissions">{message.permissionMode}</Fact>
      <Fact label="Directory">
        <span className="font-mono">{message.cwd}</span>
      </Fact>
      <Fact label="MCP">
        {message.mcp_servers.length === 0
          ? NONE
          : message.mcp_servers.map((server) => (
              <span key={server.name} className="block">
                {server.name}{' '}
                <span className={cn(server.status === 'failed' && 'text-destructive')}>({server.status})</span>
              </span>
            ))}
      </Fact>
      <Fact label="Plugins">
        {message.plugins.length === 0
          ? NONE
          : message.plugins.map((plugin) => (
              <span key={`${plugin.name}:${plugin.path}`} className="block" title={plugin.path}>
                {plugin.name}
                {plugin.version !== undefined && <span className="text-muted-foreground"> {plugin.version}</span>}
              </span>
            ))}
      </Fact>
      {errors.length > 0 && (
        <Fact label="Failed">
          {errors.map((error) => (
            <span key={`${error.plugin}:${error.message}`} className="block text-destructive">
              {error.plugin}: {error.message}
            </span>
          ))}
        </Fact>
      )}
    </dl>
  )
}

export function InitLine({ message }: { message: SDKSystemMessage }) {
  const failed = message.plugin_errors?.length ?? 0
  const facts = [
    modelLabel(message.model),
    permissionLabel(message.permissionMode),
    lastSegment(message.cwd),
    `${String(message.mcp_servers.length)} MCP`,
    plural(message.plugins.length, 'plugin'),
  ].join(DOT)
  return (
    <details className="text-xs">
      <summary className="flex min-h-6 max-w-full cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        <Terminal className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">Session started</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{plural(failed, 'plugin')} failed</span>}
        <span
          className="min-w-0 truncate text-muted-foreground/80"
          title={[message.model, message.permissionMode, message.cwd].join('\n')}
        >
          {facts}
        </span>
      </summary>
      <SessionFacts message={message} />
    </details>
  )
}

/** After the text, clear of the own-message nav; negative margins keep the line 16px tall. */
const TURN_COPY = 'shrink-0 -my-1 pointer-coarse:-my-3.5'

export function ResultLine({
  message,
  interrupted,
  reply,
}: {
  message: SDKResultMessage
  interrupted: boolean
  /** The turn's reply, which the line offers to copy. */
  reply: string | undefined
}) {
  const cost = turnCostOf(message)
  const text = [
    turnOutcome(message, interrupted),
    plural(message.num_turns, 'step'),
    elapsedLabel(message.duration_ms),
    ...(cost === null ? [] : [usd(cost)]),
  ].join(DOT)
  return (
    <Line
      icon={Play}
      error={message.is_error && !interrupted}
      action={reply !== undefined && <CopyIconButton text={reply} label="Copy reply" className={TURN_COPY} />}
    >
      {text}
    </Line>
  )
}

const kiloTokens = (tokens: number) => `${(tokens / 1000).toFixed(1)}k`

export function CompactLine({ message }: { message: SDKCompactBoundaryMessage }) {
  const { trigger, pre_tokens: before, post_tokens: after, duration_ms: took } = message.compact_metadata
  const text = [
    (trigger === 'auto' ? 'Compacted automatically' : 'Compacted') + compactedAt(message, before),
    after === undefined
      ? `${kiloTokens(before)} tokens before`
      : `${kiloTokens(before)} \u2192 ${kiloTokens(after)} tokens`,
    ...(took === undefined ? [] : [elapsedLabel(took)]),
  ].join(DOT)
  return <Line icon={FoldVertical}>{text}</Line>
}
