import { streamUrl } from '@/api'

/** Waits between attempts to reopen a stream the browser gave up on, the last one repeating. */
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000]
/** How long a page stays hidden before a parked stream closes, to spare battery and data. */
const HIDDEN_CLOSE_MS = 60_000

export interface StreamHandlers {
  /** Event name to handler; ids of events with one are remembered for resuming. */
  events: Record<string, (event: MessageEvent<string>) => void>
  onConnected?: (connected: boolean) => void
}

interface StreamOptions {
  /** The id of the last event an earlier stream delivered, to resume after instead of starting over. */
  after?: string | null
  /** Closes the stream once the page has been hidden a while, and resumes it when shown again. */
  parkWhenHidden?: boolean
}

export interface LiveEventStream {
  /** Opens a fresh connection now, resuming after the last event seen. */
  reconnect: () => void
  close: () => void
}

/**
 * An EventSource that reopens when the server refused or dropped it, as a restart or an expired
 * proxy session does, resuming with `after` set to the id of the last event it received.
 */
export function openEventStream(path: string, handlers: StreamHandlers, options: StreamOptions = {}): LiveEventStream {
  let source: EventSource | null = null
  let lastId = options.after ?? null
  let attempt = 0
  let timer: number | undefined
  let parkTimer: number | undefined
  let closed = false

  const url = () => {
    if (lastId === null) {
      return streamUrl(path)
    }
    const joiner = path.includes('?') ? '&' : '?'
    return streamUrl(`${path}${joiner}after=${encodeURIComponent(lastId)}`)
  }

  const schedule = () => {
    window.clearTimeout(timer)
    const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 30_000
    attempt += 1
    timer = window.setTimeout(open, wait)
  }

  function open() {
    window.clearTimeout(timer)
    source?.close()
    const next = new EventSource(url())
    source = next
    next.addEventListener('open', () => {
      attempt = 0
      handlers.onConnected?.(true)
    })
    next.addEventListener('error', () => {
      handlers.onConnected?.(false)
      if (next.readyState === EventSource.CLOSED && !closed && source === next) {
        schedule()
      }
    })
    for (const [name, handler] of Object.entries(handlers.events)) {
      next.addEventListener(name, (event: MessageEvent<string>) => {
        if (event.lastEventId !== '') {
          lastId = event.lastEventId
        }
        handler(event)
      })
    }
  }

  const reviveIfClosed = () => {
    if (!closed && document.visibilityState === 'visible' && source?.readyState === EventSource.CLOSED) {
      attempt = 0
      open()
    }
  }

  /** Closes the connection until the page shows or the network returns, which reopen it. */
  const park = () => {
    window.clearTimeout(timer)
    source?.close()
    handlers.onConnected?.(false)
  }

  const onVisibility = () => {
    window.clearTimeout(parkTimer)
    if (document.visibilityState !== 'hidden') {
      reviveIfClosed()
    } else if (options.parkWhenHidden === true) {
      parkTimer = window.setTimeout(park, HIDDEN_CLOSE_MS)
    }
  }

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', reviveIfClosed)
  // A socket from before a network drop can hang open unnoticed, so drop it and resume later.
  window.addEventListener('offline', park)
  open()
  onVisibility()

  return {
    reconnect: () => {
      if (!closed) {
        attempt = 0
        open()
      }
    },
    close: () => {
      closed = true
      window.clearTimeout(timer)
      window.clearTimeout(parkTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', reviveIfClosed)
      window.removeEventListener('offline', park)
      source?.close()
      handlers.onConnected?.(false)
    },
  }
}
