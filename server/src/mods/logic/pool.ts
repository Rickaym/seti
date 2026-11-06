import {
  LogicChild,
  PoolClosedError,
  type ChildEvents,
  type ChildOptions,
  type Job,
  type ModEventResult,
  type ModLogicJob,
} from './child.js'
import { EventCounters } from './dispatch.js'

export interface ModLogicPoolOptions extends ChildOptions {
  /** Children at most; each runs one event at a time. */
  size: number
}

/** Runs mod events in locked-down child processes; a child that faults is killed and replaced. */
export function createModLogicPool(options: ModLogicPoolOptions) {
  const children: LogicChild[] = []
  const queue: Job[] = []
  let closed = false

  const events: ChildEvents = {
    free: () => {
      dispatch()
    },
    gone: (child) => {
      children.splice(children.indexOf(child), 1)
      dispatch()
    },
  }

  /**
   * An idle child that may run the mod's event: its own, or a fresh one; null while none is free.
   * A child of another mod is retired to make room, and its going dispatches again, so an engine
   * escape in one mod never sees another mod's events.
   */
  function childFor(mod: string): LogicChild | null {
    const idle = children.filter((candidate) => candidate.idle)
    const own = idle.find((candidate) => candidate.mod === mod) ?? idle.find((candidate) => candidate.mod === null)
    if (own !== undefined) {
      return own
    }
    if (children.length < options.size) {
      const child = new LogicChild(options, events)
      children.push(child)
      return child
    }
    idle[0]?.retire('Its runner made room for another mod')
    return null
  }

  function dispatch(): void {
    while (!closed && queue.length > 0) {
      const next = queue[0]
      const child = next === undefined ? null : childFor(next.request.run.modId)
      if (child === null) {
        return
      }
      const job = queue.shift()
      if (job !== undefined) {
        child.start(job)
      }
    }
  }

  const stopping = () => new PoolClosedError('Seti is stopping; the event did not run')

  return {
    /** Runs one event; resolves with its result, or rejects when the pool closes. */
    run: async (request: ModLogicJob): Promise<ModEventResult> => {
      if (closed) {
        throw stopping()
      }
      const done = new Promise<ModEventResult>((resolve, reject) => {
        const job = { request, counters: new EventCounters(), callIds: new Set<number>(), queued: Date.now() }
        queue.push({ ...job, resolve, reject })
      })
      dispatch()
      return done
    },
    /** The process ids of the running children, as spawned. */
    pids: () => children.map((child) => child.pid).filter((pid) => pid !== undefined),
    /** Stops every child; events still running or waiting fail. */
    close: (): void => {
      closed = true
      for (const job of queue.splice(0)) {
        job.reject(stopping())
      }
      for (const child of [...children]) {
        child.closing = true
        child.retire('Seti stopped while the event ran')
      }
    },
  }
}

export type ModLogicPool = ReturnType<typeof createModLogicPool>
