import { SETI_CONTROL_LABELS, type SetiControlLevel, type Task } from '@seti/shared'
import { tasks } from './db.js'
import { appendMessage, type TurnPreface } from './runner.js'
import { processSetiControl } from './seti-tools/process-control.js'
import { setiControlNotes } from './store/processes.js'
import { inLane } from './task-lane.js'
import { setTaskSetiControl } from './tasks.js'

/** What the agent reads at its next turn, by the new level and whether its process has it yet. */
const PREFACES: Record<SetiControlLevel, { loaded: string; pending: string }> = {
  full: {
    loaded:
      'Seti control is now Full: load the mcp__seti__* tools (list_tasks, get_task, agent_activity, ' +
      'read_transcript, post_team_chat and more) with ToolSearch.',
    pending: 'Seti control is now Full; its mcp__seti__* tools load when your session next restarts.',
  },
  self: {
    loaded:
      'Seti control is now Self: your mcp__seti__* tools (get_task, agent_access, link_context_pack, ' +
      'list_channels and more) read Seti and change only you; load them with ToolSearch.',
    pending: 'Seti control is now Self: mcp__seti__* tools that reach past you refuse calls.',
  },
  off: {
    loaded: 'Seti control is now off: of the mcp__seti__* tools only set_status, send_file and ask_secret remain.',
    pending:
      'Seti control is now off: the mcp__seti__* tools beyond set_status, send_file and ask_secret refuse calls.',
  },
}

/** Sets an agent's Seti control level and leaves a note the agent reads at its next turn. */
export async function changeSetiControl(task: Task, level: SetiControlLevel): Promise<void> {
  const was = await setTaskSetiControl(task, level)
  if (was === null) {
    return
  }
  const note = `Seti control set to ${SETI_CONTROL_LABELS[level]}`
  await inLane(task.id, async () =>
    appendMessage(task.id, { kind: 'seti', payload: { error: note, seti_control: level, seti_control_was: was } }),
  )
}

/** The Seti control change since the agent last read a message, unless it was undone since. */
export async function setiControlPreface(taskId: string): Promise<TurnPreface | null> {
  const changes = await setiControlNotes.sinceLastTurn(taskId)
  const level = (await tasks.get(taskId))?.seti_control
  const first = changes[0]
  if (first === undefined || level === undefined || first.was === level) {
    return null
  }
  const texts = PREFACES[level]
  return { text: processSetiControl(taskId) === level ? texts.loaded : texts.pending, count: 1 }
}
