import { latencyStats, type LatencyProbe } from '@/lib/latency'

/** Polls wait this many times their interval while the link is poor. */
export const SLOW_FACTOR = 4

/** Pings needed before the round trips can slow polling, so one bad answer cannot. */
const MIN_PINGS = 5
/** A median above this slows polling; Chrome calls 3g from 270 ms and 2g from 1400 ms. */
const SLOW_RTT_MS = 600
/** The median must fall below this before polling speeds up again. */
const FAST_RTT_MS = 300
/** More than this share of the kept pings lost slows polling, and never a single loss. */
const SLOW_LOSS = 0.1
const MIN_LOST = 2
/** Polling speeds up again only once this many latest pings all answered. */
const CLEAR_PINGS = 5

export interface LinkHints {
  saveData: boolean
  effectiveType: string | null
}

export interface LinkState {
  online: boolean
  /** Polls run at SLOW_FACTOR times their interval. */
  slow: boolean
  /** Why polls are slowed, for the status bar; null while they run at full speed. */
  reason: string | null
}

/** Whether the kept round trips call for slow polling, with the gap between the two thresholds. */
export function judgeLatency(wasSlow: boolean, results: readonly (number | null)[]): string | null {
  const stats = latencyStats(results)
  const pings = results.length
  if (pings < MIN_PINGS) {
    return wasSlow ? 'the link was poor' : null
  }
  const lost = pings - (stats?.count ?? 0)
  const median = stats?.median ?? Number.POSITIVE_INFINITY
  const lossText = `${String(lost)} of the last ${String(pings)} pings lost`
  const rttText = `median round trip ${String(Math.round(median))} ms`
  if (!wasSlow) {
    if (lost >= MIN_LOST && lost / pings > SLOW_LOSS) {
      return lossText
    }
    return median > SLOW_RTT_MS ? rttText : null
  }
  const recentLost = results.slice(-CLEAR_PINGS).some((r) => r === null)
  if (recentLost) {
    return lossText
  }
  return median >= FAST_RTT_MS ? rttText : null
}

/** What the browser says about the connection, which outranks the pings. */
export function hintReason(hints: LinkHints): string | null {
  if (hints.saveData) {
    return 'Data Saver is on'
  }
  if (hints.effectiveType === '2g' || hints.effectiveType === 'slow-2g') {
    return `the browser reports a ${hints.effectiveType} connection`
  }
  return null
}

export interface LinkEnv {
  online: () => boolean
  hints: () => LinkHints
  /** Calls `onChange` on online, offline and connection changes; returns the removal. */
  listen: (onChange: () => void) => () => void
}

export interface Link {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => LinkState
}

/** Online state and link quality, watched only while someone subscribes. */
export function createLink(probe: LatencyProbe, env: LinkEnv): Link {
  let state: LinkState = { online: env.online(), slow: false, reason: null }
  let latencyReason: string | null = null
  let stop: (() => void) | null = null
  const listeners = new Set<() => void>()

  const update = () => {
    const online = env.online()
    const reconnected = online && !state.online
    const results = reconnected ? [] : probe.getSnapshot().results
    latencyReason = judgeLatency(!reconnected && latencyReason !== null, results)
    const reason = hintReason(env.hints()) ?? latencyReason
    const slow = reason !== null
    if (online !== state.online || slow !== state.slow || reason !== state.reason) {
      state = { online, slow, reason }
      for (const listener of listeners) {
        listener()
      }
    }
    if (reconnected) {
      probe.forget()
    }
  }

  const start = () => {
    const unlisten = env.listen(update)
    const unprobe = probe.subscribe(update)
    const release = probe.keepSampling()
    update()
    return () => {
      unlisten()
      unprobe()
      release()
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      stop ??= start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && stop !== null) {
          stop()
          stop = null
        }
      }
    },
    getSnapshot: () => state,
  }
}
