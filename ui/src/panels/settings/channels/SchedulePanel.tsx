import type { ChannelInfo, EaFollowup } from '@seti/shared'
import { AlarmClock, Headset, Radar } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { apiGet } from '@/api'
import { browserTimezone } from '@/components/schedule/cron'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { navigate } from '@/lib/route'
import { DeliveryLabel } from './DeliveryPicker'
import {
  AGENDA_RANGES,
  buildAgenda,
  type AgendaDay,
  type AgendaEntry,
  type AgendaKind,
  type AgendaRangeId,
} from './agenda'

const KINDS: Record<AgendaKind, { label: string; icon: typeof Radar }> = {
  poller: { label: 'Poller', icon: Radar },
  reminder: { label: 'Reminder', icon: AlarmClock },
  followup: { label: 'Follow-up', icon: Headset },
}

const TICK_MS = 60_000

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

const isRange = (value: string): value is AgendaRangeId => AGENDA_RANGES.some((range) => range.id === value)

/** The time now, refreshed each minute so runs that passed leave the list. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNow(new Date())
    }, TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }, [])
  return now
}

/** The EA's scheduled follow-ups; none when they cannot be read. */
function useFollowups(): EaFollowup[] {
  const [followups, setFollowups] = useState<EaFollowup[]>([])
  useEffect(() => {
    apiGet<EaFollowup[]>('/ea/followups').then(setFollowups, () => {
      setFollowups([])
    })
  }, [])
  return followups
}

function Entry({ entry, onOpen }: { entry: AgendaEntry; onOpen: (entry: AgendaEntry) => void }) {
  const { label, icon: Icon } = KINDS[entry.kind]
  const runs = entry.runs > 1 ? `, ${String(entry.runs)} runs` : ''
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted"
        onClick={() => {
          onOpen(entry)
        }}
      >
        <time dateTime={entry.at} className="w-11 shrink-0 text-sm font-medium tabular-nums">
          {clock(entry.at)}
        </time>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.name}</span>
          <span className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
            <span>
              {entry.detail}
              {runs}
            </span>
            {entry.deliveries.map((delivery) => (
              <DeliveryLabel key={delivery ?? 'agent'} delivery={delivery} />
            ))}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
          <span className="max-md:sr-only">{label}</span>
        </span>
      </button>
    </li>
  )
}

function Day({ day, onOpen }: { day: AgendaDay; onOpen: (entry: AgendaEntry) => void }) {
  return (
    <section aria-label={day.label}>
      <h3 className="mb-1.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{day.label}</h3>
      <ul className="border border-border bg-card text-xs">
        {day.entries.map((entry) => (
          <Entry key={entry.key} entry={entry} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  )
}

/** What pollers, reminders and the EA's follow-ups run next, by day in the viewer's time. */
export function SchedulePanel({ channels, onOpen }: { channels: ChannelInfo[]; onOpen: (channelId: string) => void }) {
  const [range, setRange] = useState<AgendaRangeId>('7d')
  const now = useNow()
  const followups = useFollowups()
  const timezone = browserTimezone()
  const span = AGENDA_RANGES.find((item) => item.id === range) ?? AGENDA_RANGES[0]
  const agenda = useMemo(
    () => buildAgenda({ channels, followups, now, hours: span.hours, timezone }),
    [channels, followups, now, span.hours, timezone],
  )
  const open = (entry: AgendaEntry) => {
    if (entry.kind === 'followup') {
      navigate('ea')
    } else {
      onOpen(entry.id)
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Times in {timezone}</p>
        <Tabs
          value={range}
          onValueChange={(value) => {
            if (isRange(value)) {
              setRange(value)
            }
          }}
        >
          <TabsList aria-label="Range">
            {AGENDA_RANGES.map(({ id, label, hint }) => (
              <TabsTrigger key={id} value={id} title={hint} className="px-3">
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {agenda.days.length === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="schedule-empty">
          Nothing runs in {span.hint.toLowerCase()}. Pollers, reminders and the EA&apos;s follow-ups show here.
        </p>
      )}
      {agenda.days.map((day) => (
        <Day key={day.key} day={day} onOpen={open} />
      ))}
      {agenda.paused.length > 0 && (
        <section aria-label="Paused" className="text-xs text-muted-foreground">
          <span>{String(agenda.paused.length)} paused: </span>
          {agenda.paused.map((channel, index) => (
            <span key={channel.id}>
              {index > 0 && ', '}
              <button
                type="button"
                className="py-1 text-foreground underline underline-offset-2"
                onClick={() => {
                  onOpen(channel.id)
                }}
              >
                {channel.name}
              </button>
            </span>
          ))}
        </section>
      )}
      {agenda.days.length > 0 && (
        <p className="text-xs text-muted-foreground">
          A line with a run count stands for a day&apos;s runs from the time shown. Interval runs are projected from the
          next run, so a poller&apos;s shift a little and move back after a failure.
        </p>
      )}
    </div>
  )
}
