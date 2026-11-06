import { Worker, type ResourceLimits } from 'node:worker_threads'
import type { RunRequest, RunResult, WorkerMessage } from './worker-protocol.js'

export interface PollerPoolOptions {
  /** Workers at most; each runs one poll at a time and further runs wait their turn. */
  size: number
  /** V8 heap caps per worker; the script's own memory is the engine's separate wasm cap. */
  resourceLimits: ResourceLimits
  /** How long a new worker may take to load before its run fails. */
  startupMs: number
  /** The module a worker runs; tests swap it for one that misbehaves. */
  entry?: URL
}

export type PollRequest = Omit<RunRequest, 'runId'>

interface Job {
  request: PollRequest
  /** Past this after the run is handed over, the worker is stopped from outside. */
  wallMs: number
  resolve: (result: RunResult) => void
  reject: (error: Error) => void
}

interface WorkerEvents {
  free: () => void
  /** The worker is stopped; its run, if any, has failed. */
  gone: (worker: PollWorker) => void
}

const DEFAULT_ENTRY = new URL('./worker-entry.ts', import.meta.url)

/** A run Seti stopped because it is shutting down; the run did not fail on its own account. */
export class PoolClosedError extends Error {}

function crashReason(error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return 'The poller worker ran out of memory and was replaced'
  }
  return `The poller worker failed and was replaced: ${error instanceof Error ? error.message : String(error)}`
}

/** One worker thread and the run it has, if any; stopped for good on a crash or overrun. */
class PollWorker {
  private readonly worker: Worker
  private readonly options: PollerPoolOptions
  private readonly events: WorkerEvents
  private ready = false
  private retired = false
  /** Set as the pool closes, so the run it stops fails as stopped rather than as broken. */
  closing = false
  private job: Job | null = null
  private runId = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private static nextRunId = 1

  constructor(options: PollerPoolOptions, events: WorkerEvents) {
    this.options = options
    this.events = events
    this.worker = new Worker(options.entry ?? DEFAULT_ENTRY, { resourceLimits: options.resourceLimits })
    this.worker.on('message', (message: WorkerMessage) => {
      this.receive(message)
    })
    this.worker.on('error', (error: unknown) => {
      this.retire(crashReason(error))
    })
    this.worker.on('messageerror', (error: Error) => {
      this.retire(crashReason(error))
    })
    this.worker.on('exit', (code) => {
      this.retire(`The poller worker stopped unexpectedly (exit code ${String(code)}) and was replaced`)
    })
  }

  get idle(): boolean {
    return this.job === null && !this.retired
  }

  get threadId(): number {
    return this.worker.threadId
  }

  start(job: Job): void {
    this.job = job
    this.worker.ref()
    if (!this.ready) {
      this.setTimer(this.options.startupMs, () => {
        this.retire(`The poller worker did not start within ${String(this.options.startupMs / 1000)} s`)
      })
      return
    }
    this.runId = PollWorker.nextRunId++
    this.setTimer(job.wallMs, () => {
      const seconds = String(job.request.limits.timeoutMs / 1000)
      this.retire(`The script ran over its ${seconds} s timeout and its worker was stopped`)
    })
    this.worker.postMessage({ ...job.request, runId: this.runId } satisfies RunRequest)
  }

  retire(reason: string): void {
    if (this.retired) {
      return
    }
    this.retired = true
    this.setTimer(null)
    this.job?.reject(this.closing ? new PoolClosedError(reason) : new Error(reason))
    this.job = null
    void this.worker.terminate()
    this.events.gone(this)
  }

  async stopped(): Promise<void> {
    await this.worker.terminate()
  }

  private setTimer(ms: number | null, fn?: () => void): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (ms !== null && fn !== undefined) {
      this.timer = setTimeout(fn, ms)
    }
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'ready') {
      this.ready = true
      this.setTimer(null)
      if (this.job === null) {
        this.worker.unref()
      } else {
        this.start(this.job)
      }
      return
    }
    const job = this.job
    if (job === null || message.runId !== this.runId) {
      return
    }
    this.setTimer(null)
    this.job = null
    this.worker.unref()
    if (message.type === 'result') {
      job.resolve(message.result)
    } else {
      job.reject(new Error(message.error))
    }
    if (message.type === 'result' && message.retire === true) {
      this.retire('The engine failed on its last run')
      return
    }
    this.events.free()
  }
}

/** Runs polls in worker threads, off the server's event loop; a worker that fails is replaced. */
export function createPollerPool(options: PollerPoolOptions) {
  const workers: PollWorker[] = []
  const queue: Job[] = []
  let closed = false

  const events: WorkerEvents = {
    free: () => {
      dispatch()
    },
    gone: (worker) => {
      workers.splice(workers.indexOf(worker), 1)
      dispatch()
    },
  }

  function dispatch(): void {
    while (!closed && queue.length > 0) {
      let worker = workers.find((candidate) => candidate.idle)
      if (worker === undefined && workers.length < options.size) {
        worker = new PollWorker(options, events)
        workers.push(worker)
      }
      const job = worker === undefined ? undefined : queue.shift()
      if (worker === undefined || job === undefined) {
        return
      }
      worker.start(job)
    }
  }

  const stopping = () => new PoolClosedError('Seti is stopping; the run did not start')

  return {
    /** Runs one poll; rejects when its worker fails, is stopped, or the pool closes. */
    run: async (request: PollRequest, wallMs: number): Promise<RunResult> => {
      if (closed) {
        throw stopping()
      }
      const done = new Promise<RunResult>((resolve, reject) => {
        queue.push({ request, wallMs, resolve, reject })
      })
      dispatch()
      return done
    },
    threadIds: () => workers.map((worker) => worker.threadId),
    /** Stops every worker; runs still going or waiting fail. */
    close: async (): Promise<void> => {
      closed = true
      for (const job of queue.splice(0)) {
        job.reject(stopping())
      }
      const all = [...workers]
      for (const worker of all) {
        worker.closing = true
        worker.retire('Seti stopped while the poller ran')
      }
      await Promise.all(all.map(async (worker) => worker.stopped()))
    },
  }
}

export type PollerPool = ReturnType<typeof createPollerPool>
