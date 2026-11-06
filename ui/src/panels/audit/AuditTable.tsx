import type { AuditEvent } from '@seti/shared'
import { AlertTriangle, AudioLines, ChevronRight, Globe } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useNarrow } from '@/hooks/useMedia'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import {
  actorStyle,
  eventLinks,
  exactTime,
  isOutward,
  sentDetail,
  viaNote,
  type SentDetail,
  type ViaNote,
} from './format'

const VIA_ICON = { public: Globe, ea: AudioLines } as const

function ViaIcon({ note }: { note: ViaNote }) {
  const Icon = VIA_ICON[note.via]
  return (
    <span title={note.text} data-via={note.via}>
      <Icon className="size-3 shrink-0 text-muted-foreground" role="img" aria-label={note.text} />
    </span>
  )
}

function ActorBadge({ actor, note }: { actor: AuditEvent['actor']; note: ViaNote | null }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cn('px-1.5 py-0.5 text-2xs font-semibold uppercase', actorStyle(actor))}>{actor}</span>
      {note !== null && <ViaIcon note={note} />}
    </span>
  )
}

const detailsId = (event: AuditEvent) => `audit-sent-${String(event.id)}`

/** The summary as a disclosure button that shows what an outward call sent. */
function SummaryToggle({
  event,
  open,
  onToggle,
  wrap,
}: {
  event: AuditEvent
  open: boolean
  onToggle: () => void
  wrap: boolean
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={detailsId(event)}
      onClick={onToggle}
      className="flex w-full min-w-0 items-start gap-1 text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
    >
      <ChevronRight
        aria-hidden
        className={cn('mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
      />
      <span className={wrap ? 'wrap-anywhere' : 'truncate'}>{event.summary}</span>
    </button>
  )
}

function SentField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-2xs font-semibold text-muted-foreground uppercase">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function SentDetails({ event, sent }: { event: AuditEvent; sent: SentDetail }) {
  return (
    <div id={detailsId(event)} className="space-y-2 text-xs whitespace-normal">
      <dl aria-label="What was sent" className="space-y-2">
        {sent.tool !== null && (
          <SentField label="Tool">
            <span className="font-mono wrap-anywhere">{sent.tool}</span>
          </SentField>
        )}
        {sent.target !== null && (
          <SentField label="To">
            <span className="font-mono wrap-anywhere">{sent.target}</span>
          </SentField>
        )}
        {sent.text !== null && (
          <SentField label="Text">
            <p className="whitespace-pre-wrap wrap-anywhere">{sent.text}</p>
          </SentField>
        )}
        {sent.input !== null && (
          <SentField label="Input">
            <pre className="max-h-80 overflow-auto bg-muted/60 p-2 font-mono text-2xs whitespace-pre-wrap wrap-anywhere">
              {sent.input}
            </pre>
          </SentField>
        )}
      </dl>
      {sent.truncated && <p className="text-muted-foreground">Cut to fit the audit log.</p>}
    </div>
  )
}

function EventRow({ event, now }: { event: AuditEvent; now: number }) {
  const outward = isOutward(event)
  const sent = sentDetail(event)
  const [open, setOpen] = useState(false)
  const rowTone = outward && 'border-l-warning bg-warning/10 hover:bg-warning/15'
  return (
    <>
      <TableRow data-kind={event.kind} className={cn('border-l-2 border-l-transparent', rowTone)}>
        <TableCell className="w-[84px] align-top text-muted-foreground tabular-nums" title={exactTime(event.at)}>
          {relativeTime(event.at, now)}
        </TableCell>
        <TableCell className="w-[72px] align-top">
          <ActorBadge actor={event.actor} note={viaNote(event)} />
        </TableCell>
        <TableCell className="w-[210px] align-top">
          <EventKind event={event} outward={outward} />
        </TableCell>
        {sent === null ? (
          <TableCell className="max-w-0 truncate align-top" title={event.summary}>
            {event.summary}
          </TableCell>
        ) : (
          <TableCell className="max-w-0 align-top" title={event.summary}>
            <SummaryToggle
              event={event}
              open={open}
              wrap={false}
              onToggle={() => {
                setOpen(!open)
              }}
            />
          </TableCell>
        )}
        <TableCell className="w-[160px] text-right align-top">
          <EventLinks event={event} />
        </TableCell>
      </TableRow>
      {sent !== null && open && (
        <TableRow data-sent-for={event.id} className={cn('border-l-2 border-l-transparent', rowTone)}>
          <TableCell colSpan={5} className="pl-[calc(84px+72px+210px+0.5rem)]">
            <SentDetails event={event} sent={sent} />
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function EventLinks({ event }: { event: AuditEvent }) {
  return (
    <span className="inline-flex max-w-full gap-2">
      {eventLinks(event).map((link) => (
        <a
          key={link.href}
          href={link.href}
          title={link.label}
          className="truncate text-primary hover:underline"
          {...(link.href.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}
        >
          {link.label}
        </a>
      ))}
    </span>
  )
}

function EventKind({ event, outward }: { event: AuditEvent; outward: boolean }) {
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1 font-mono',
        outward ? 'text-warning-text' : 'text-muted-foreground',
      )}
    >
      {outward && <AlertTriangle className="size-3 shrink-0" aria-label="outward" />}
      <span className="truncate">{event.kind}</span>
    </span>
  )
}

function EventItem({ event, now }: { event: AuditEvent; now: number }) {
  const outward = isOutward(event)
  const sent = sentDetail(event)
  const [open, setOpen] = useState(false)
  return (
    <li
      data-kind={event.kind}
      className={cn(
        'space-y-1 border-b border-l-2 border-border border-l-transparent px-3 py-2 last:border-b-0',
        outward && 'border-l-warning bg-warning/10',
      )}
    >
      <div className="flex items-center gap-2">
        <ActorBadge actor={event.actor} note={viaNote(event)} />
        <EventKind event={event} outward={outward} />
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums" title={exactTime(event.at)}>
          {relativeTime(event.at, now)}
        </span>
      </div>
      {sent === null ? (
        <p className="wrap-anywhere">{event.summary}</p>
      ) : (
        <SummaryToggle
          event={event}
          open={open}
          wrap
          onToggle={() => {
            setOpen(!open)
          }}
        />
      )}
      {sent !== null && open && <SentDetails event={event} sent={sent} />}
      <EventLinks event={event} />
    </li>
  )
}

/** Events as stacked entries on phones, where the table's columns do not fit. */
function EventList({ events, now }: { events: readonly AuditEvent[]; now: number }) {
  return (
    <ul aria-label="Audit events" className="text-xs">
      {events.map((event) => (
        <EventItem key={event.id} event={event} now={now} />
      ))}
    </ul>
  )
}

export function AuditTable({ events, now }: { events: readonly AuditEvent[]; now: number }) {
  const narrow = useNarrow()
  if (narrow) {
    return <EventList events={events} now={now} />
  }
  return (
    <Table className="table-fixed">
      <TableHeader>
        <TableRow className="border-l-2 border-l-transparent">
          <TableHead className="w-[84px]">Time</TableHead>
          <TableHead className="w-[72px]">Actor</TableHead>
          <TableHead className="w-[210px]">Event</TableHead>
          <TableHead>Summary</TableHead>
          <TableHead className="w-[160px] text-right">Subject</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((event) => (
          <EventRow key={event.id} event={event} now={now} />
        ))}
      </TableBody>
    </Table>
  )
}
