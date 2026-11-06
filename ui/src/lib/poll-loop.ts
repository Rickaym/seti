import { appLink } from '@/lib/app-link'
import { SLOW_FACTOR, type Link } from '@/lib/link'

export interface PollOptions {
  /** Keep polling while the page is hidden, for work that finishes on another device. */
  whileHidden?: boolean
  /** Run once at the start too, when online. */
  leading?: boolean
  link?: Link
}

const hidden = () => document.visibilityState === 'hidden'

/** Runs `run` each interval, paused offline or hidden, slowed on a poor link; returns the stop. */
export function startPolling(
  run: () => void,
  intervalMs: number,
  { whileHidden = false, leading = false, link = appLink }: PollOptions = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let state = link.getSnapshot()

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(fire, state.slow ? intervalMs * SLOW_FACTOR : intervalMs)
  }

  function fire() {
    if (state.online && (whileHidden || !hidden())) {
      run()
    }
    schedule()
  }

  const onLink = () => {
    const before = state
    state = link.getSnapshot()
    if (state.online && !before.online) {
      fire()
    } else if (state.slow !== before.slow) {
      schedule()
    }
  }

  const onVisibility = () => {
    if (!hidden()) {
      fire()
    }
  }

  const unsubscribe = link.subscribe(onLink)
  state = link.getSnapshot()
  document.addEventListener('visibilitychange', onVisibility)
  if (leading && state.online) {
    run()
  }
  schedule()
  return () => {
    clearTimeout(timer)
    unsubscribe()
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
