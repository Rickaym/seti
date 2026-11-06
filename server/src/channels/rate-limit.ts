/** ok, or over the limit; `first` marks the first refusal of a window, so it is recorded once. */
export type RateVerdict = { ok: true } | { ok: false; first: boolean; retryAfterS: number }

/** A fixed-window counter per key, in memory; a window resets on the first request after it ends. */
export function createRateLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return (key: string): RateVerdict => {
    const at = now()
    let window = windows.get(key)
    if (window === undefined || at - window.start >= windowMs) {
      window = { start: at, count: 0 }
      windows.set(key, window)
    }
    window.count += 1
    if (window.count <= limit) {
      return { ok: true }
    }
    const retryAfterS = Math.max(1, Math.ceil((window.start + windowMs - at) / 1000))
    return { ok: false, first: window.count === limit + 1, retryAfterS }
  }
}
