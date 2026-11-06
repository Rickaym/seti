type SessionListener = (taskId: string) => void | Promise<void>

const openListeners: SessionListener[] = []

/** Called before a task's Claude Code process starts, outside the task's lane. */
export function onSessionOpen(listener: SessionListener): void {
  openListeners.push(listener)
}

/** Runs the open listeners; a failing one is logged, since the session must start regardless. */
export async function sessionOpening(taskId: string): Promise<void> {
  for (const listener of openListeners) {
    try {
      await listener(taskId)
    } catch (e) {
      process.stderr.write(`session open: task ${taskId}: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }
}
