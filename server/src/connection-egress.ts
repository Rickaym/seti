import type { GrantConnection, Task } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'
import { sandboxPolicy } from './store/sandbox.js'

/** The connections the task's credential carries: settings and stored names, never a value. */
export const taskConnections = async (task: Task): Promise<ConnectionRow[]> => connectionRows.ofProfile(task.profile_id)

/** A connection as the egress proxy applies it: hosts, header and placeholder, no value. */
export const grantConnection = (row: ConnectionRow): GrantConnection => ({
  id: row.id,
  name: row.name,
  env: row.env,
  placeholder: row.placeholder,
  hosts: [...row.hosts],
  header: row.header,
  minted: row.kind !== 'key' && row.mint !== null,
})

export const grantConnections = (rows: readonly ConnectionRow[]): GrantConnection[] => rows.map(grantConnection)

/** A request that carried connection placeholders toward a host their connections do not allow. */
export async function auditBlockedKey(taskId: string, host: string, names: readonly string[]): Promise<void> {
  const title = (await tasks.get(taskId))?.title ?? taskId
  await audit
    .record({
      actor: 'agent',
      kind: 'task.api_key_blocked',
      subject_type: 'task',
      subject_id: taskId,
      summary: `Blocked a request of task "${title}" to ${host} carrying the connection ${names.join(', ')}`,
      detail: { title, host, keys: [...names] },
    })
    .catch(() => undefined)
}

/** Names the variables that hold placeholders and their hosts, so the agent uses them as is. */
export async function connectionContext(taskId: string): Promise<string | null> {
  const task = await tasks.get(taskId)
  if (task === undefined) {
    return null
  }
  const rows = (await taskConnections(task)).filter((row) => row.hosts.length > 0)
  if (rows.length === 0) {
    return null
  }
  const list = rows.map((row) => `${row.env} (${row.hosts.join(', ')})`).join(', ')
  const sandboxed = task.sandbox && (await sandboxPolicy.get()).enabled
  const swap = sandboxed
    ? "Seti's proxy swaps in the real value on those hosts only, in the URL and headers (Basic auth " +
      'too); it never swaps one in a request body, such as a password in a JSON or form login, and ' +
      'refuses such a request unsent'
    : "only Seti's sandbox proxy swaps in the real values, so calls with them fail outside the sandbox"
  return `Connections: ${list} hold Seti placeholders: ${swap}. Never print env values or ask for the keys.`
}
