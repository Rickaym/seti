import { AsyncLocalStorage } from 'node:async_hooks'

/** The lane a piece of work holds; it stops counting once that work has finished. */
interface Hold {
  taskId: string
  active: boolean
}

const held = new AsyncLocalStorage<Hold>()
const tails = new Map<string, Promise<unknown>>()

/** Runs `fn` after earlier work of the task, one at a time; work holding the lane runs in place. */
export async function inLane<T>(taskId: string, fn: () => T | Promise<T>): Promise<T> {
  const current = held.getStore()
  if (current?.active === true && current.taskId === taskId) {
    return await fn()
  }
  const run = async () => {
    const hold: Hold = { taskId, active: true }
    try {
      return await held.run(hold, fn)
    } finally {
      hold.active = false
    }
  }
  const previous = tails.get(taskId) ?? Promise.resolve()
  const result = previous.then(run, run)
  const tail = result.then(
    () => undefined,
    () => undefined,
  )
  tails.set(taskId, tail)
  void tail.then(() => {
    if (tails.get(taskId) === tail) {
      tails.delete(taskId)
    }
  })
  return result
}

/** Resolves once the task's lane is empty, including work queued while waiting. */
export async function laneSettled(taskId: string): Promise<void> {
  for (let tail = tails.get(taskId); tail !== undefined; tail = tails.get(taskId)) {
    await tail
    if (tails.get(taskId) === tail) {
      return
    }
  }
}

/** Runs `fn` outside the caller's lane; detached work that needs a lane must start through it. */
export async function outsideLane<T>(fn: () => Promise<T>): Promise<T> {
  return held.exit(fn)
}
