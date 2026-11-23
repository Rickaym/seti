import { compactedWithin, eventsOf, modelLabel, rowEvents, type EventOf, type WireRow } from '@seti/shared'
import { FoldVertical, Play, Terminal } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { CopyIconButton } from '@/components/CopyButton'
import { compactFailure } from '@/lib/compacting'
import type { RefusalChange } from '@/lib/model-fallback'
import { usd } from '@/lib/money'
import { DOT, lastSegment, permissionLabel, plural, turnOutcome } from '@/lib/session-labels'
import { elapsedLabel } from '@/lib/time'
import { localCommandOutput } from '@/lib/transcript'
import { cn } from '@/lib/utils'
import { ModelFallbackNotice } from '@/panels/tasks/ModelFallbackNotice'

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
function SessionFacts({ start }: { start: EventOf<'session.started'> }) {
  const errors = start.pluginErrors ?? []
  const plugins = start.plugins ?? []
  return (
    <dl className="mt-1 ml-5.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 bg-muted p-2 text-2xs">
      <Fact label="Session">
        <span className="font-mono">{start.sessionId}</span>
      </Fact>
      <Fact label="Model">{start.model}</Fact>
      <Fact label="Permissions">{start.mode}</Fact>
      <Fact label="Directory">
        <span className="font-mono">{start.cwd}</span>
      </Fact>
      <Fact label="MCP">
        {start.servers.length === 0
          ? NONE
          : start.servers.map((server) => (
              <span key={server.name} className="block">
                {server.name}{' '}
                <span className={cn(server.status === 'failed' && 'text-destructive')}>({server.status})</span>
              </span>
            ))}
      </Fact>
      <Fact label="Plugins">
        {plugins.length === 0
          ? NONE
          : plugins.map((plugin) => (
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

function InitLine({ start }: { start: EventOf<'session.started'> }) {
  const failed = start.pluginErrors?.length ?? 0
  const facts = [
    modelLabel(start.model),
    permissionLabel(start.mode ?? ''),
    lastSegment(start.cwd ?? ''),
    `${String(start.servers.length)} MCP`,
    plural(start.plugins?.length ?? 0, 'plugin'),
  ].join(DOT)
  return (
    <details className="text-xs">
      <summary className="flex min-h-6 max-w-full cursor-pointer items-center gap-2 text-muted-foreground hover:text-foreground pointer-coarse:min-h-11">
        <Terminal className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">Session started</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{plural(failed, 'plugin')} failed</span>}
        <span
          className="min-w-0 truncate text-muted-foreground/80"
          title={[start.model, start.mode, start.cwd].join('\n')}
        >
          {facts}
        </span>
      </summary>
      <SessionFacts start={start} />
    </details>
  )
}

/** After the text, clear of the own-message nav; negative margins keep the line 16px tall. */
const TURN_COPY = 'shrink-0 -my-1 pointer-coarse:-my-3.5'

function ResultLine({
  end,
  interrupted,
  reply,
}: {
  end: EventOf<'turn.ended'>
  interrupted: boolean
  /** The turn's reply, which the line offers to copy. */
  reply: string | undefined
}) {
  const text = [
    turnOutcome(end, interrupted),
    plural(end.steps ?? 0, 'step'),
    elapsedLabel(end.durationMs ?? 0),
    ...(end.costUsd === undefined ? [] : [usd(end.costUsd)]),
  ].join(DOT)
  return (
    <Line
      icon={Play}
      error={end.status === 'error' && !interrupted}
      action={reply !== undefined && <CopyIconButton text={reply} label="Copy reply" className={TURN_COPY} />}
    >
      {text}
    </Line>
  )
}

const kiloTokens = (tokens: number) => `${(tokens / 1000).toFixed(1)}k`

function CompactLine({ compaction }: { compaction: EventOf<'compaction'> }) {
  const { trigger, before = 0, after, durationMs: took } = compaction
  const text = [
    (trigger === 'auto' ? 'Compacted automatically' : 'Compacted') + compactedWithin(compaction.window, before),
    after === undefined
      ? `${kiloTokens(before)} tokens before`
      : `${kiloTokens(before)} \u2192 ${kiloTokens(after)} tokens`,
    ...(took === undefined ? [] : [elapsedLabel(took)]),
  ].join(DOT)
  return <Line icon={FoldVertical}>{text}</Line>
}

/** The line a runtime row that is not the agent's output shows, or `children` when it shows none. */
export function RuntimeLine({
  row,
  taskId,
  interrupted,
  reply,
  children,
}: {
  row: WireRow
  taskId: string
  interrupted: boolean
  reply: string | undefined
  children: ReactNode
}) {
  const events = rowEvents(row)
  const [start] = eventsOf(events, 'session.started')
  if (start !== undefined) {
    return <InitLine start={start} />
  }
  const [end] = eventsOf(events, 'turn.ended')
  if (end !== undefined) {
    return <ResultLine end={end} interrupted={interrupted} reply={reply} />
  }
  const done = eventsOf(events, 'compaction').find((event) => event.phase === 'done')
  if (done !== undefined) {
    return <CompactLine compaction={done} />
  }
  const fallback = eventsOf(events, 'model.changed').find(
    (event): event is RefusalChange => event.refusal !== undefined,
  )
  if (fallback !== undefined) {
    return <ModelFallbackNotice taskId={taskId} change={fallback} />
  }
  const failure = compactFailure(row)
  if (failure !== null) {
    return (
      <Line icon={FoldVertical} error>
        compaction failed: {failure}
      </Line>
    )
  }
  const local = localCommandOutput(row)
  if (local === null) {
    return <>{children}</>
  }
  return (
    <Line icon={Terminal}>
      <span className="font-mono whitespace-pre-wrap">{local === '' ? 'command done' : local}</span>
    </Line>
  )
}
