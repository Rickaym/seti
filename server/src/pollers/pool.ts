import { createWorkerPool, type WorkerPool, type WorkerPoolOptions } from '../quickjs/pool.js'
import type { PollRequest, RunResult } from './worker-protocol.js'

export type PollerPool = WorkerPool<PollRequest, RunResult>

/** The worker pool polls run in; tests swap the entry for one that misbehaves. */
export const createPollerPool = (options: Omit<WorkerPoolOptions, 'name' | 'entry'> & { entry?: URL }): PollerPool =>
  createWorkerPool<PollRequest, RunResult>({
    name: 'poller',
    entry: new URL('./worker-entry.ts', import.meta.url),
    ...options,
  })
