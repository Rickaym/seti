import { memoryNote, type MemoryReport } from '@seti/shared'
import { inBackground } from './background.js'
import { tasks } from './db.js'
import { onMemoryEvent } from './memory-scope.js'
import { appendMessage } from './runner.js'
import { inLane, outsideLane } from './task-lane.js'

/** The memory cap stopped the agent's Claude Code, so its turn is over. */
const endedTurn = (report: MemoryReport) =>
  report.event === 'oom_kill' && report.kind === 'agent' && report.victims?.root === true

/** Tells the task's transcript that a process of it hit its memory cap, or that it throttles. */
async function noteMemoryEvent(taskId: string, report: MemoryReport): Promise<void> {
  if ((await tasks.get(taskId)) === undefined) {
    return
  }
  const payload = {
    error: memoryNote(report),
    memory: report.event,
    ...(endedTurn(report) ? { ended_turn: true } : {}),
  }
  await outsideLane(async () => inLane(taskId, async () => appendMessage(taskId, { kind: 'seti', payload })))
}

/**
 * Notes every memory event of an agent's scope in its transcript and the server log; a side
 * chat's stay out of the transcript, since nothing of a side chat reaches it.
 */
export function recordMemoryEvents(): void {
  onMemoryEvent((taskId, report) => {
    process.stderr.write(`memory: task ${taskId}: ${memoryNote(report)}\n`)
    if (report.kind !== 'side_chat') {
      inBackground('memory: could not note a memory event', async () => noteMemoryEvent(taskId, report))
    }
  })
}
