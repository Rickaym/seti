import type { PermissionRequest, Task } from '@seti/shared'
import { appendMessage } from './runner.js'
import { inLane } from './task-lane.js'

/**
 * Notes in the agent's transcript that the user edited a call before they answered it, by field
 * name only, so the transcript shows the call did not run, or was refused, as the agent wrote it.
 */
export async function noteEdit(task: Task, request: PermissionRequest): Promise<void> {
  if (request.edited.length === 0 || task.archived_at !== null) {
    return
  }
  const fields = request.edited.join(', ')
  const denied = request.state === 'denied'
  const error = denied
    ? `Edited ${fields} of ${request.tool_name}, then denied it`
    : `Edited ${fields} of ${request.tool_name} before it ran`
  const payload = { error, edited: { fields: [...request.edited], denied, tool: request.tool_name } }
  await inLane(task.id, async () => appendMessage(task.id, { kind: 'seti', payload }))
}
