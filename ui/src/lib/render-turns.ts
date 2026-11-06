/** Runs in a task of its own, so each turn's work commits apart from the last. */
const nextTask = (run: () => void) => {
  setTimeout(run, 0)
}

interface Waiter {
  key: string
  start: () => void
}

/** Turns handed out one at a time, the next in a new task once the last one ended. */
export function createRenderTurns(schedule: (run: () => void) => void = nextTask) {
  const waiting: Waiter[] = []
  let holder: string | null = null
  let pending = false

  const pump = () => {
    pending = false
    if (holder !== null) {
      return
    }
    const next = waiting.shift()
    if (next !== undefined) {
      holder = next.key
      next.start()
    }
  }

  const release = (key: string) => {
    if (holder !== key) {
      return
    }
    holder = null
    if (!pending) {
      pending = true
      schedule(pump)
    }
  }

  return {
    /** Queues `start`, `first` ahead of the rest; the returned function ends the turn or wait. */
    wait: (key: string, first: boolean, start: () => void): (() => void) => {
      const waiter = { key, start }
      if (first) {
        waiting.unshift(waiter)
      } else {
        waiting.push(waiter)
      }
      if (holder === null && !pending) {
        pump()
      }
      return () => {
        const index = waiting.indexOf(waiter)
        if (index !== -1) {
          waiting.splice(index, 1)
        }
        release(key)
      }
    },
  }
}
