/** Detached work still running, which shutdown waits for before the database closes. */
const running = new Set<Promise<void>>()
const stoppers: (() => Promise<void>)[] = []
let stopping = false

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Starts work nobody awaits and logs its failure; after shutdown began, work is dropped. */
export function inBackground(label: string, work: () => Promise<unknown>): void {
  if (stopping) {
    return
  }
  const run = (async () => {
    try {
      await work()
    } catch (e) {
      process.stderr.write(`${label}: ${errorText(e)}\n`)
    }
  })()
  running.add(run)
  void run.then(() => running.delete(run))
}

/** Registers how a module ends long-lived work; stoppers run in the order they registered. */
export function onShutdown(stop: () => Promise<void>): void {
  stoppers.push(stop)
}

/** Refuses new background work, waits for what runs, then ends long-lived work such as sessions. */
export async function shutdown(): Promise<void> {
  stopping = true
  await Promise.all(running)
  for (const stop of stoppers) {
    await stop()
  }
}
