import { Worker, type ResourceLimits } from 'node:worker_threads'

/** What every run carries: its own timeout, which the pool names when it stops an overrun. */
export interface PoolRequest {
  limits: { timeoutMs: number }
}

/** Worker to pool: ready once loaded, then one reply per run; `retire` asks for a new worker. */
export type PoolMessage<Result> =
  | { type: 'ready' }
  | { type: 'result'; runId: number; result: Result; retire?: true }
  | { type: 'error'; runId: number; error: string }

export interface WorkerPoolOptions {
  /** What the workers run, as error messages name them, such as poller. */
  name: string
  /** Workers at most; each runs one script at a time and further runs wait their turn. */
  size: number
  /** V8 heap caps per worker; the script's own memory is the engine's separate wasm cap. */
  resourceLimits: ResourceLimits
  /** How long a new worker may take to load before its run fails. */
  startupMs: number
  /** The module a worker runs; tests swap it for one that misbehaves. */
  entry: URL
}

interface Job<Request, Result> {
  request: Request
  /** Past this after the run is handed over, the worker is stopped from outside. */
  wallMs: number
  resolve: (result: Result) => void
  reject: (error: Error) => void
}

interface WorkerEvents<Request extends PoolRequest, Result> {
  free: () => void
  /** The worker is stopped; its run, if any, has failed. */
  gone: (worker: PoolWorker<Request, Result>) => void
}

/** A run Seti stopped because it is shutting down; the run did not fail on its own account. */
export class PoolClosedError extends Error {}

function crashReason(name: string, error: unknown): string {
  if (error instanceof Error && 'code' in error && error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return `The ${name} worker ran out of memory and was replaced`
  }
  return `The ${name} worker failed and was replaced: ${error instanceof Error ? error.message : String(error)}`
}

/** One worker thread and the run it has, if any; stopped for good on a crash or overrun. */
class PoolWorker<Request extends PoolRequest, Result> {
  private readonly worker: Worker
  private readonly options: WorkerPoolOptions
  private readonly events: WorkerEvents<Request, Result>
  private ready = false
  private retired = false
  /** Set as the pool closes, so the run it stops fails as stopped rather than as broken. */
  closing = false
  private job: Job<Request, Result> | null = null
  private runId = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private static nextRunId = 1

  constructor(options: WorkerPoolOptions, events: WorkerEvents<Request, Result>) {
    this.options = options
    this.events = events
    this.worker = new Worker(options.entry, { resourceLimits: options.resourceLimits })
    this.worker.on('message', (message: PoolMessage<Result>) => {
      this.receive(message)
    })
    this.worker.on('error', (error: unknown) => {
      this.retire(crashReason(options.name, error))
    })
    this.worker.on('messageerror', (error: Error) => {
      this.retire(crashReason(options.name, error))
    })
    this.worker.on('exit', (code) => {
      this.retire(`The ${options.name} worker stopped unexpectedly (exit code ${String(code)}) and was replaced`)
    })
  }

  get idle(): boolean {
    return this.job === null && !this.retired
  }

  get threadId(): number {
    return this.worker.threadId
  }

  start(job: Job<Request, Result>): void {
    this.job = job
    this.worker.ref()
    if (!this.ready) {
      this.setTimer(this.options.startupMs, () => {
        const seconds = String(this.options.startupMs / 1000)
        this.retire(`The ${this.options.name} worker did not start within ${seconds} s`)
      })
      return
    }
    this.runId = PoolWorker.nextRunId++
    this.setTimer(job.wallMs, () => {
      const seconds = String(job.request.limits.timeoutMs / 1000)
      this.retire(`The script ran over its ${seconds} s timeout and its worker was stopped`)
    })
    this.worker.postMessage({ ...job.request, runId: this.runId })
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

  private receive(message: PoolMessage<Result>): void {
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

export interface WorkerPool<Request extends PoolRequest, Result> {
  /**
   * Runs one script; rejects when its worker fails, is stopped, or the pool closes, and with
   * `waitMs` when no worker took it within that long.
   */
  run: (request: Request, wallMs: number, waitMs?: number) => Promise<Result>
  /** Starts a worker ahead of the first run when none is up, so that run does not wait for it. */
  warm: () => void
  threadIds: () => number[]
  /** Stops every worker; runs still going or waiting fail. */
  close: () => Promise<void>
}

/** Runs scripts in worker threads, off the server's event loop; a worker that fails is replaced. */
export function createWorkerPool<Request extends PoolRequest, Result>(
  options: WorkerPoolOptions,
): WorkerPool<Request, Result> {
  const workers: PoolWorker<Request, Result>[] = []
  const queue: Job<Request, Result>[] = []
  let closed = false

  const events: WorkerEvents<Request, Result> = {
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
        worker = new PoolWorker<Request, Result>(options, events)
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

  /** Takes a run off the queue once it waited `waitMs` without a free worker. */
  function expire(job: Job<Request, Result>, waitMs: number): void {
    setTimeout(() => {
      const at = queue.indexOf(job)
      if (at !== -1) {
        queue.splice(at, 1)
        job.reject(new Error(`Every ${options.name} worker stayed busy for ${String(waitMs / 1000)} s`))
      }
    }, waitMs).unref()
  }

  return {
    run: async (request: Request, wallMs: number, waitMs?: number): Promise<Result> => {
      if (closed) {
        throw stopping()
      }
      const done = new Promise<Result>((resolve, reject) => {
        const job = { request, wallMs, resolve, reject }
        queue.push(job)
        if (waitMs !== undefined) {
          expire(job, waitMs)
        }
      })
      dispatch()
      return done
    },
    warm: (): void => {
      if (!closed && workers.length === 0) {
        workers.push(new PoolWorker<Request, Result>(options, events))
      }
    },
    threadIds: () => workers.map((worker) => worker.threadId),
    close: async (): Promise<void> => {
      closed = true
      for (const job of queue.splice(0)) {
        job.reject(stopping())
      }
      const all = [...workers]
      for (const worker of all) {
        worker.closing = true
        worker.retire(`Seti stopped while the ${options.name} ran`)
      }
      await Promise.all(all.map(async (worker) => worker.stopped()))
    },
  }
}
