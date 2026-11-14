const TICK_MS = 1000

const WORKER_SOURCE = `setInterval(() => postMessage(0), ${String(TICK_MS)})`

/** A one-second tick from a worker, whose timers keep time while the page is in the background. */
export function everySecond(tick: () => void): () => void {
  let url: string | null = null
  try {
    url = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }))
    const worker = new Worker(url)
    worker.addEventListener('message', tick)
    return () => {
      worker.terminate()
      if (url !== null) {
        URL.revokeObjectURL(url)
      }
    }
  } catch {
    if (url !== null) {
      URL.revokeObjectURL(url)
    }
    const timer = window.setInterval(tick, TICK_MS)
    return () => {
      window.clearInterval(timer)
    }
  }
}
