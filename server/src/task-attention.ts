import {
  displayStatus,
  needsYou,
  prStates,
  runningSubtasks,
  type AgentNotifyKind,
  type Task,
  type TaskStatus,
} from '@seti/shared'
import { messages } from './db.js'
import { openQuerySince } from './runner.js'
import { prWatch } from './store/pr-watch.js'
import { subtaskBriefs } from './subtask-cache.js'

const RESULT_SCAN = 40

/** The agent's closing words of its last turn, from the result message. */
export async function lastResult(taskId: string): Promise<string> {
  const page = await messages.page(taskId, RESULT_SCAN)
  const result = page.messages.findLast((row) => row.kind === 'sdk' && row.payload.type === 'result')
  if (result?.kind !== 'sdk' || result.payload.type !== 'result' || result.payload.subtype !== 'success') {
    return ''
  }
  return result.payload.result
}

/** What a task's state means for the user: a needs-you state, a finished turn, or nothing. */
export async function attentionOf(task: Task, status: TaskStatus): Promise<AgentNotifyKind | null> {
  const [states, subtasks] = await Promise.all([
    prWatch.taskStates(task.id),
    subtaskBriefs(task.id, openQuerySince(task.id)),
  ])
  const shown = displayStatus(task, prStates(states), runningSubtasks(subtasks))
  if (needsYou(status) || needsYou(shown)) {
    return 'needs_you'
  }
  return status === 'idle' && shown !== 'running' ? 'finished' : null
}
