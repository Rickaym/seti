/** Round trips kept for the figures; a lost ping is kept as null. */
const KEEP = 10
const BURST = 5
const WATCH_MS = 2000
const BACKGROUND_MS = 30_000

interface LatencyState {
  /** Round trips in milliseconds, oldest first. */
  results: readonly (number | null)[]
  measuring: boolean
}

export interface LatencyStats {
  median: number
  /** Mean change between consecutive round trips, as RFC 3550 measures interarrival jitter. */
  jitter: number
  count: number
  lost: number
}

export function latencyStats(results: readonly (number | null)[]): LatencyStats | null {
  const samples = results.filter((r) => r !== null)
  if (samples.length === 0) {
    return null
  }
  const sorted = samples.toSorted((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const upper = sorted[mid] ?? 0
  const median = sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2
  const steps = samples.slice(1).map((sample, i) => Math.abs(sample - (samples[i] ?? sample)))
  const jitter = steps.length === 0 ? 0 : steps.reduce((sum, step) => sum + step, 0) / steps.length
  return { median, jitter, count: samples.length, lost: results.length - samples.length }
}

export interface LatencyProbe {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => LatencyState
  /** One ping every 30 s while the page is visible, until the returned stop is called. */
  keepSampling: () => () => void
  /** A burst of pings now, then one every 2 s while visible, until the returned stop is called. */
  watch: () => () => void
  /** Drops the kept round trips, as after a reconnect makes them stale. */
  forget: () => void
}

/** Times round trips one at a time, so none queues behind another, and only while asked to. */
export function createLatencyProbe(ping: () => Promise<number>, visible: () => boolean): LatencyProbe {
  let state: LatencyState = { results: [], measuring: false }
  let samplers = 0
  let watchers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  let queued = 0
  const listeners = new Set<() => void>()

  const update = (change: Partial<LatencyState>) => {
    state = { ...state, ...change }
    for (const listener of listeners) {
      listener()
    }
  }

  const drain = async () => {
    update({ measuring: true })
    while (queued > 0) {
      queued -= 1
      const rtt = await ping().catch(() => null)
      update({ results: [...state.results, rtt].slice(-KEEP) })
    }
    update({ measuring: false })
  }

  const measure = (count: number) => {
    const idle = queued === 0 && !state.measuring
    queued = Math.max(queued, count)
    if (idle) {
      void drain()
    }
  }

  const schedule = () => {
    clearInterval(timer)
    timer = undefined
    if (watchers > 0) {
      timer = setInterval(() => {
        if (visible()) {
          measure(1)
        }
      }, WATCH_MS)
    } else if (samplers > 0) {
      timer = setInterval(() => {
        if (visible()) {
          measure(1)
        }
      }, BACKGROUND_MS)
    }
  }

  const hold = (change: 1 | -1, kind: 'sampler' | 'watcher') => {
    if (kind === 'sampler') {
      samplers += change
    } else {
      watchers += change
    }
    schedule()
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    keepSampling: () => {
      hold(1, 'sampler')
      return () => {
        hold(-1, 'sampler')
      }
    },
    watch: () => {
      hold(1, 'watcher')
      measure(BURST)
      return () => {
        hold(-1, 'watcher')
      }
    },
    forget: () => {
      if (state.results.length > 0) {
        update({ results: [] })
      }
    },
  }
}
