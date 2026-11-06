import { useEffect, useSyncExternalStore } from 'react'
import { ItemHint, StatusBarItem } from '@/components/status-bar/StatusBarItem'
import { apiTone } from '@/components/status-bar/tone'
import { useLatency, useLink } from '@/hooks/useLatency'
import { useNow } from '@/hooks/useNow'
import { useSystem } from '@/hooks/useSystem'
import { latencyProbe } from '@/lib/app-link'
import { latencyStats } from '@/lib/latency'
import { SLOW_FACTOR } from '@/lib/link'
import { liveStream } from '@/lib/live-stream'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'

type Connection = 'pending' | 'up' | 'down' | 'offline'

const DOT: Record<Connection, string> = {
  pending: 'bg-muted-foreground/60',
  up: 'bg-success',
  down: 'bg-destructive',
  offline: 'border border-muted-foreground',
}

function connection(online: boolean, error: string | null, lastOk: number | null): Connection {
  if (!online) {
    return 'offline'
  }
  if (error !== null) {
    return 'down'
  }
  return lastOk === null ? 'pending' : 'up'
}

function lastSeen(lastOk: number | null): string {
  return lastOk === null
    ? 'It has not answered since this page loaded.'
    : `Last answer ${relativeTime(new Date(lastOk).toISOString())}.`
}

const ms = (value: number) => `${String(Math.round(value))} ms`

function LatencyLine() {
  const { results, measuring } = useLatency()
  const stats = latencyStats(results)
  if (stats === null) {
    return (
      <span data-testid="api-latency">
        Latency: {measuring || results.length === 0 ? 'measuring...' : `no answer to ${String(results.length)} pings.`}
      </span>
    )
  }
  const lost = stats.lost > 0 ? `, ${String(stats.lost)} lost` : ''
  return (
    <span data-testid="api-latency">
      Latency: {ms(stats.median)} median, {ms(stats.jitter)} jitter ({stats.count} pings{lost}).
    </span>
  )
}

function StreamLine() {
  const { connected, lastEventAt } = useSyncExternalStore(liveStream.subscribe, liveStream.getSnapshot)
  const now = useNow(true)
  const last =
    lastEventAt === null ? 'no event yet' : `last event ${relativeTime(new Date(lastEventAt).toISOString(), now)}`
  return (
    <span data-testid="api-stream">
      Live stream: {connected ? 'connected' : 'reconnecting'}, {last}.
    </span>
  )
}

/** Mounted only while the hint shows, so the burst of pings runs only while someone looks. */
function ConnectionHint({ summary, slowedBy }: { summary: string; slowedBy: string | null }) {
  useEffect(() => latencyProbe.watch(), [])
  return (
    <ItemHint title={summary}>
      <LatencyLine />
      <StreamLine />
      {slowedBy !== null && (
        <span data-testid="api-slowed">
          Polling slowed {SLOW_FACTOR}x: {slowedBy}.
        </span>
      )}
    </ItemHint>
  )
}

export function ApiStatusItem() {
  const { error, lastOk } = useSystem()
  const link = useLink()
  const state = connection(link.online, error, lastOk)
  useEffect(() => latencyProbe.keepSampling(), [])
  const summaries: Record<Connection, string> = {
    pending: 'Connecting to the Seti server...',
    up: 'Connected to the Seti server.',
    down: `The Seti server is not answering /api/system (${error ?? ''}). ${lastSeen(lastOk)}`,
    offline: 'This browser is offline. Seti stops polling and catches up once it is back online.',
  }
  return (
    <StatusBarItem
      label={`API ${state}`}
      name="API"
      tone={apiTone(error, link.online)}
      tooltip={<ConnectionHint summary={summaries[state]} slowedBy={link.online ? link.reason : null} />}
    >
      <span className={cn('size-2', DOT[state])} />
      API
    </StatusBarItem>
  )
}
