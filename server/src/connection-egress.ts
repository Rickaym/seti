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
  body: row.body,
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

const OUTSIDE = "only Seti's sandbox proxy swaps in the real values, so calls with them fail outside the sandbox"

const IN_BODIES =
  ", and for those marked 'bodies too' also in JSON, form, multipart text and plain text request " +
  'bodies up to 1 MiB. It refuses unsent any other request that carries one in its body'
const NOT_IN_BODIES =
  '. It never swaps one into a request body, such as a password in a JSON or form login, and refuses ' +
  'such a request unsent'

/** Where the proxy puts a value, so an agent never posts a placeholder the proxy will not swap. */
const swapText = (bodies: boolean) =>
  `Seti's proxy swaps in the real value on those hosts only, in the URL and headers (Basic auth too)` +
  `${bodies ? IN_BODIES : NOT_IN_BODIES}; the user can turn on Body for a connection in Settings, Connections`

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
  const list = rows.map((row) => `${row.env} (${row.hosts.join(', ')}${row.body ? '; bodies too' : ''})`).join(', ')
  const sandboxed = task.sandbox && (await sandboxPolicy.get()).enabled
  const swap = sandboxed ? swapText(rows.some((row) => row.body)) : OUTSIDE
  return `Connections: ${list} hold Seti placeholders: ${swap}. Never print env values or ask for the keys.`
}
