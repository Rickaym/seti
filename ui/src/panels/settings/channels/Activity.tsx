import type {
  ChannelDelivery,
  ChannelDeliveryStatus,
  ChannelEvent,
  ChannelInfo,
  PollerRun,
  ReminderRun,
  ReminderRunOutcome,
} from '@seti/shared'
import { ChevronDown, ExternalLink, History } from 'lucide-react'
import type { ReactNode } from 'react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { plural } from '@/lib/session-labels'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { ROUTE_TONE } from './subscriptions'

const STATE_TONE: Record<string, string> = { down: 'text-destructive', up: 'text-success' }

const DELIVERY_TONE: Record<ChannelDeliveryStatus, string> = {
  accepted: 'text-success',
  duplicate: 'text-muted-foreground',
  ignored: 'text-muted-foreground',
  rejected: 'text-destructive',
  rate_limited: 'text-warning-text',
}

/** A row whose detail opens below it when there is any. */
function Row({ summary, detail }: { summary: ReactNode; detail: string }) {
  return (
    <li className="border-b border-border px-3 py-2 last:border-b-0">
      {detail === '' ? (
        <div className="flex">{summary}</div>
      ) : (
        <details>
          <summary className="flex cursor-pointer list-none">{summary}</summary>
          <pre className="mt-2 max-h-40 overflow-auto bg-muted p-2 font-mono text-2xs break-all whitespace-pre-wrap">
            {detail}
          </pre>
        </details>
      )}
    </li>
  )
}

function runSummary(run: PollerRun): string {
  if (!run.ok) {
    return run.error ?? 'failed'
  }
  const notes = run.invalid.length > 0 ? `, ${plural(run.invalid.length, 'note')}` : ''
  return `${plural(run.items, 'item')}, ${plural(run.emitted, 'event')}${notes}`
}

function RunLine({ run }: { run: PollerRun }) {
  const detail = [...(run.error === null ? [] : [run.error]), ...run.invalid, ...run.logs]
  const summary = (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className={cn('w-14 shrink-0 font-semibold uppercase', run.ok ? 'text-success' : 'text-destructive')}>
        {run.ok ? 'ok' : 'failed'}
      </span>
      <span className="min-w-0 flex-1 break-words">{runSummary(run)}</span>
      <span className="shrink-0 text-muted-foreground">
        {run.trigger === 'manual' ? 'by hand, ' : ''}
        {relativeTime(run.started_at)}, {(run.duration_ms / 1000).toFixed(1)} s
      </span>
    </span>
  )
  return <Row summary={summary} detail={detail.join('\n')} />
}

const REMINDER_TONE: Record<ReminderRunOutcome, string> = {
  ok: 'text-success',
  empty: 'text-muted-foreground',
  error: 'text-destructive',
  timeout: 'text-destructive',
}

function ReminderRunLine({ run }: { run: ReminderRun }) {
  const text = run.error ?? run.message ?? 'Nothing to deliver'
  const detail = [...(run.message?.includes('\n') === true ? [run.message] : []), ...run.logs]
  const summary = (
    <span className="flex min-w-0 flex-1 items-start gap-2">
      <span className={cn('w-16 shrink-0 font-semibold uppercase', REMINDER_TONE[run.outcome])}>{run.outcome}</span>
      <span className="min-w-0 flex-1 truncate">{text.split('\n')[0]}</span>
      <span className="shrink-0 text-muted-foreground">
        {run.trigger === 'manual' ? 'by hand, ' : ''}
        {relativeTime(run.started_at)}, {(run.duration_ms / 1000).toFixed(1)} s
      </span>
    </span>
  )
  return <Row summary={summary} detail={detail.join('\n')} />
}

function EventLine({ event }: { event: ChannelEvent }) {
  return (
    <li className="flex items-start gap-2 border-b border-border px-3 py-2 last:border-b-0">
      <span
        className={cn(
          'w-16 shrink-0 font-semibold uppercase',
          STATE_TONE[event.state ?? ''] ?? 'text-muted-foreground',
        )}
      >
        {event.state ?? event.severity}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words">{event.title}</div>
        <div className="text-muted-foreground">
          {event.source}, {relativeTime(event.created_at)}
        </div>
      </div>
      {event.url !== null && (
        <a
          href={event.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${event.title}`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </li>
  )
}

function Routes({ delivery }: { delivery: ChannelDelivery }) {
  if (delivery.routes.length === 0) {
    return null
  }
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-34 max-md:pl-0" data-testid="delivery-routes">
      {delivery.routes.map((route) => (
        <span key={`${route.target}:${route.task_id ?? ''}`} title={route.reason}>
          {route.label}: <span className={cn('font-semibold', ROUTE_TONE[route.outcome])}>{route.outcome}</span>
        </span>
      ))}
    </span>
  )
}

function DeliveryLine({ delivery }: { delivery: ChannelDelivery }) {
  const summary = (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="flex min-w-0 items-start gap-2">
        <span className={cn('w-24 shrink-0 font-semibold uppercase', DELIVERY_TONE[delivery.status])}>
          {delivery.status.replace('_', ' ')}
        </span>
        <span className="w-8 shrink-0 font-mono text-muted-foreground">
          {delivery.http_status === 0 ? 'poll' : delivery.http_status}
        </span>
        <span className="min-w-0 flex-1 break-words">{delivery.reason}</span>
        <span className="shrink-0 text-muted-foreground">{relativeTime(delivery.received_at)}</span>
      </span>
      <Routes delivery={delivery} />
    </span>
  )
  return <Row summary={summary} detail={delivery.excerpt} />
}

/** A titled list of a channel's newest rows; the server sends only the few it shows. */
function Block<T>({
  title,
  label,
  rows,
  render,
}: {
  title: string
  label: string
  rows: readonly T[]
  render: (row: T) => ReactNode
}) {
  return (
    <div className="border-t border-border">
      <div className="px-3 pt-2 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{title}</div>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-muted-foreground">Nothing yet.</p>
      ) : (
        <ul aria-label={label}>{rows.map(render)}</ul>
      )}
    </div>
  )
}

function runsOf(info: ChannelInfo): readonly { started_at: string }[] {
  if (info.source === 'poller') {
    return info.poller.runs
  }
  return info.source === 'reminder' ? info.reminder.runs : []
}

/** When the channel last did anything: its newest run, event or delivery. */
function lastActive(info: ChannelInfo): string | null {
  const times = [
    ...runsOf(info).map((run) => run.started_at),
    ...info.recent.map((event) => event.created_at),
    ...info.deliveries.map((delivery) => delivery.received_at),
  ]
  return times.reduce<string | null>((a, b) => (a !== null && a > b ? a : b), null)
}

/** A channel's newest runs, events and deliveries, folded away until opened. */
export function Activity({ info }: { info: ChannelInfo }) {
  const last = lastActive(info)
  return (
    <Collapsible className="group/activity border-t border-border">
      <CollapsibleTrigger
        className="flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted"
        aria-label={`${info.name} activity`}
      >
        <History className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">Activity</span>
        <span className="min-w-0 flex-1 truncate text-right text-muted-foreground">
          {last === null ? 'Nothing yet' : `Last ${relativeTime(last)}`}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/activity:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {info.source === 'poller' && (
          <Block
            title="Runs"
            label={`${info.name} runs`}
            rows={info.poller.runs}
            render={(run) => <RunLine key={run.id} run={run} />}
          />
        )}
        {info.source === 'reminder' && (
          <Block
            title="Runs"
            label={`${info.name} runs`}
            rows={info.reminder.runs}
            render={(run) => <ReminderRunLine key={run.id} run={run} />}
          />
        )}
        <Block
          title="Events"
          label={`${info.name} events`}
          rows={info.recent}
          render={(event) => <EventLine key={event.id} event={event} />}
        />
        <Block
          title="Deliveries"
          label={`${info.name} deliveries`}
          rows={info.deliveries}
          render={(delivery) => <DeliveryLine key={delivery.id} delivery={delivery} />}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
