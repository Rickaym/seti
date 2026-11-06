import type { Link } from '@/lib/link'

/** How long one attempt may wait for the server to start answering. */
const SEND_TIMEOUT_MS = 20_000
/** Waits before each retry; after the last the send fails. */
const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 8000, 15_000]

/** An attempt that got no answer in time; the server may still have taken it. */
export class SendTimeout extends Error {
  constructor() {
    super('Seti did not answer in time')
  }
}

const RETRY_STATUSES = new Set([502, 503, 504])

const statusOf = (e: unknown): number | null =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : null

/** Network faults, timeouts and gateway errors; a 4xx or any other answer is final. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof SendTimeout || e instanceof TypeError) {
    return true
  }
  const status = statusOf(e)
  return status !== null && RETRY_STATUSES.has(status)
}

/** Whether the browser has a network, and a wait for it to come back. */
export interface Connectivity {
  online: () => boolean
  whenOnline: (signal?: AbortSignal) => Promise<void>
}

/** The app's link state as connectivity, so retries pause offline like polls do. */
export function linkConnectivity(link: Link): Connectivity {
  return {
    online: () => link.getSnapshot().online,
    whenOnline: async (signal) => {
      const cleanups: (() => void)[] = []
      try {
        await new Promise<void>((resolve) => {
          const check = () => {
            if (link.getSnapshot().online || signal?.aborted === true) {
              resolve()
            }
          }
          cleanups.push(link.subscribe(check))
          signal?.addEventListener('abort', check)
          cleanups.push(() => {
            signal?.removeEventListener('abort', check)
          })
          check()
        })
      } finally {
        for (const cleanup of cleanups) {
          cleanup()
        }
      }
    },
  }
}

export interface RetryOptions {
  /** Stops the send and its retries, as when the user stops a reply. */
  signal?: AbortSignal
  /** Called before each retry with its number, from 1. */
  onRetrying?: (retry: number) => void
  timeoutMs?: number
  delaysMs?: readonly number[]
  /** Without it, retries never wait for the network. */
  connectivity?: Connectivity
}

const sleep = async (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done)
  })

/** One attempt: `signal` ends it, `answered` stops its timeout once the answer starts. */
export type Attempt<T> = (signal: AbortSignal, answered: () => void) => Promise<T>

async function attemptOnce<T>(attempt: Attempt<T>, timeoutMs: number, outer?: AbortSignal): Promise<T> {
  const controller = new AbortController()
  const timeout = new SendTimeout()
  const timer = setTimeout(() => {
    controller.abort(timeout)
  }, timeoutMs)
  const forward = () => {
    controller.abort(outer?.reason)
  }
  outer?.addEventListener('abort', forward)
  const ended = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(controller.signal.reason as Error)
    })
  })
  ended.catch(() => undefined)
  try {
    const answered = () => {
      clearTimeout(timer)
    }
    return await Promise.race([attempt(controller.signal, answered), ended])
  } catch (e) {
    throw controller.signal.reason === timeout ? timeout : e
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', forward)
  }
}

/**
 * Runs the attempt, retrying with backoff on network faults, timeouts and gateway errors, and
 * waiting while the browser is offline. The caller keeps the same client id across retries.
 */
export async function withRetry<T>(attempt: Attempt<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? RETRY_DELAYS_MS
  const { connectivity } = options
  const { signal } = options
  const stopped = () => signal?.aborted === true
  for (let retry = 0; ; retry += 1) {
    try {
      return await attemptOnce(attempt, options.timeoutMs ?? SEND_TIMEOUT_MS, signal)
    } catch (e) {
      const delay = delays[retry]
      if (delay === undefined || stopped() || !isRetryable(e)) {
        throw e
      }
      options.onRetrying?.(retry + 1)
      await sleep(delay, signal)
      if (connectivity !== undefined && !connectivity.online()) {
        await connectivity.whenOnline(signal)
      }
      if (stopped()) {
        throw e
      }
    }
  }
}
