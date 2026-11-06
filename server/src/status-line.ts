import { inBackground } from './background.js'
import { tasks } from './db.js'
import { sessionState } from './runner.js'
import { onAnyTaskEvent } from './task-events.js'

/** A turn's end clears the agent's status line, unless background work it started still runs. */
export async function statusLineTurnEnded(taskId: string): Promise<void> {
  if (sessionState(taskId).background === 0) {
    await tasks.clearStatusLine(taskId)
  }
}

/** Clears an idle agent's status line once its background work or its session has ended. */
export function clearStatusLinesWhenIdle(): void {
  onAnyTaskEvent((taskId, event) => {
    if (event.type === 'session' && event.session.background === 0) {
      inBackground(`status line: task ${taskId}`, async () => tasks.clearStatusLine(taskId, { idle: true }))
    }
  })
}
