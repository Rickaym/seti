import type { MessageBody, MessageRow } from '@seti/shared'
import { audit } from './audit.js'
import { messages, tasks } from './db.js'
import { refusedHostLines } from './store/refused-hosts.js'
import { publish } from './task-events.js'

type Append = (taskId: string, body: MessageBody) => Promise<MessageRow>

/**
 * Notes a host the agent's sandbox refused: on the first refusal one quiet transcript line naming
 * it, audited once; later refusals only raise the count that line shows.
 */
export async function noteRefusedHost(taskId: string, host: string, count: number, append: Append): Promise<void> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return
  }
  const line = await refusedHostLines.find(taskId, host)
  if (line === undefined) {
    const payload = { error: `Sandbox refused ${host}`, refused_host: host, refused_count: count }
    await append(taskId, { kind: 'seti', payload })
    await audit.record({
      actor: 'system',
      kind: 'task.host_refused',
      subject_type: 'task',
      subject_id: taskId,
      summary: `The sandbox of task "${task.title}" refused ${host}`,
      detail: { title: task.title, host },
    })
    return
  }
  if (count <= line.count) {
    return
  }
  await refusedHostLines.count(taskId, line.id, count)
  const row = await messages.get(taskId, line.id)
  if (row !== undefined) {
    publish(taskId, { type: 'updated', row })
  }
}
