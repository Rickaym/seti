import type { CapabilitiesSummary, ChannelsSummary, ResourceSummary } from '@seti/shared'
import { createContext } from 'react'

/** Warning colours the item on the bar; only critical fills it, so it outranks a failed agent. */
export type StatusTone = 'default' | 'muted' | 'warning' | 'critical' | 'danger'

export const TONE: Record<StatusTone, string> = {
  default: 'text-foreground/80',
  muted: 'text-muted-foreground',
  warning: 'text-warning-text',
  critical: 'bg-warning-fill text-warning-foreground',
  danger: 'text-destructive',
}

const RANK: Record<StatusTone, number> = { muted: 0, default: 1, warning: 2, danger: 3, critical: 4 }

/** The tone that outranks the others, for an item that stands for several. */
export const worstTone = (tones: readonly StatusTone[]): StatusTone =>
  tones.reduce<StatusTone>((worst, tone) => (RANK[tone] > RANK[worst] ? tone : worst), 'default')

export function resourcesTone(summary: ResourceSummary): StatusTone {
  if (summary.anomalies === 0) {
    return 'default'
  }
  return summary.severity === 'critical' ? 'critical' : 'warning'
}

/** A failing poller or reminder is red, a stale or erroring one amber. */
export function channelsTone(summary: ChannelsSummary): StatusTone {
  if (summary.attention.some((entry) => entry.problem === 'failing')) {
    return 'danger'
  }
  return summary.attention.length > 0 ? 'warning' : 'default'
}

export const mcpTone = (summary: CapabilitiesSummary): StatusTone =>
  summary.servers['needs-auth'] + summary.servers.failed > 0 ? 'warning' : 'default'

export const sandboxTone = (enabled: boolean): StatusTone => (enabled ? 'default' : 'warning')

/** Offline is the browser's state, not a fault of the server, so it stays quiet. */
export function apiTone(error: string | null, online: boolean): StatusTone {
  if (!online) {
    return 'muted'
  }
  return error === null ? 'default' : 'danger'
}

/** Inside the phone's health sheet: items render as rows with their hint; a press closes it. */
export const RowContext = createContext<{ onPick: () => void } | null>(null)
