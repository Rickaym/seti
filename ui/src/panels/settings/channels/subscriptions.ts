import type { ChannelRouteOutcome } from '@seti/shared'

export const ROUTE_TONE: Record<ChannelRouteOutcome, string> = {
  delivered: 'text-success',
  queued: 'text-warning-text',
  held: 'text-warning-text',
  ignored: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
  retrying: 'text-warning-text',
}

export function filterLabel(events: readonly string[] | null): string {
  if (events === null) {
    return 'All events'
  }
  return events.length === 1 ? (events[0] ?? '') : `${String(events.length)} kinds`
}
