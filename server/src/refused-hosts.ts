import { refusedHost, type MessageBody, type MessageRow } from '@seti/shared'
import { audit } from './audit.js'
import { messages, tasks } from './db.js'
import { MAX_REFUSED_HOSTS } from './egress-refusals.js'
import { refusedHostLines } from './store/refused-hosts.js'
import { publish } from './task-events.js'

type Append = (taskId: string, body: MessageBody) => Promise<MessageRow>

const MAX_COUNT = 1_000_000_000

/** A host the agent chose could carry anything; only one the user could allow gets a line. */
const allowable = (host: string) => refusedHost.safeParse(host).data === host

/**
 * Notes a host the agent's sandbox refused: on the first refusal one quiet transcript line naming
 * it, audited once; later refusals only raise the count that line shows.
 */
export async function noteRefusedHost(taskId: string, host: string, count: number, append: Append): Promise<void> {
  const task = await tasks.get(taskId)
  if (task === undefined || !allowable(host)) {
    return
  }
  const counted = Math.min(count, MAX_COUNT)
  const line = await refusedHostLines.find(taskId, host)
  if (line === undefined) {
    if ((await refusedHostLines.hosts(taskId)) >= MAX_REFUSED_HOSTS) {
      return
    }
    const payload = { error: `Sandbox refused ${host}`, refused_host: host, refused_count: counted }
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
  if (counted <= line.count) {
    return
  }
  await refusedHostLines.count(taskId, line.id, counted)
  const row = await messages.get(taskId, line.id)
  if (row !== undefined) {
    publish(taskId, { type: 'updated', row })
  }
}
