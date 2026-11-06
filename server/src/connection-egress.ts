import { VALUE_PLACEHOLDER, type Task } from '@seti/shared'
import { audit } from './audit.js'
import { connectionValue, minterOf, tokenMinter } from './connection-values.js'
import { tasks } from './db.js'
import type { EgressPlaceholder } from './egress-placeholders.js'
import type { EgressRule } from './egress-rules.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'
import { sandboxPolicy } from './store/sandbox.js'

const HTTPS_PORT = 443
const HEADER_UNSAFE = /[\r\n\0]/

/** The connections the task's credential carries: settings and stored names, never a value. */
export const taskConnections = async (task: Task): Promise<ConnectionRow[]> => connectionRows.ofProfile(task.profile_id)

/** Each connection's variable set to its placeholder, so SDKs that need one start. */
export const connectionEnv = (rows: readonly ConnectionRow[]): Record<string, string> =>
  Object.fromEntries(rows.map((row) => [row.env, row.placeholder]))

/** The connections as the egress proxy swaps them, reading each value when a request needs it. */
export const connectionPlaceholders = (rows: readonly ConnectionRow[]): EgressPlaceholder[] =>
  rows.map((row) => ({
    name: row.name,
    placeholder: row.placeholder,
    hosts: row.hosts,
    value: async () => connectionValue(row),
  }))

const safe = (value: string | null) => (value === null || value === '' || HEADER_UNSAFE.test(value) ? null : value)

/** The token inside a header value the template made. */
function tokenOf(template: string, value: string): string {
  const [before = '', after = ''] = template.split(VALUE_PLACEHOLDER)
  return value.slice(before.length, value.length - after.length)
}

/** A connection's header as the proxy sets it: its key, or a token it mints and renews. */
export function connectionRule(
  row: ConnectionRow,
  header: NonNullable<ConnectionRow['header']>,
  minter = tokenMinter,
): EgressRule {
  const fill = (value: string | null) => {
    const checked = safe(value)
    return checked === null ? null : header.template.replaceAll(VALUE_PLACEHOLDER, checked)
  }
  const plan = minterOf(row)
  const base = { hosts: row.hosts, port: HTTPS_PORT, header: header.name.toLowerCase() }
  if (plan === null) {
    return { ...base, value: async () => fill(await connectionValue(row)) }
  }
  return {
    ...base,
    value: async () => fill((await minter.token(row.id, plan)).token),
    renew: async (_url, refused) => fill((await minter.renew(row.id, plan, tokenOf(header.template, refused))).token),
  }
}

/** The headers of the task's connections, which its session's proxy applies first. */
export const connectionRules = (rows: readonly ConnectionRow[]): EgressRule[] =>
  rows.flatMap((row) => (row.header === null || row.hosts.length === 0 ? [] : [connectionRule(row, row.header)]))

/** A request that carried connection placeholders toward a host their connections do not allow. */
export async function auditBlockedKey(task: Task, host: string, names: readonly string[]): Promise<void> {
  await audit
    .record({
      actor: 'agent',
      kind: 'task.api_key_blocked',
      subject_type: 'task',
      subject_id: task.id,
      summary: `Blocked a request of task "${task.title}" to ${host} carrying the connection ${names.join(', ')}`,
      detail: { title: task.title, host, keys: [...names] },
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
    ? "use them as usual; Seti's proxy swaps in the real value for those hosts only"
    : "only Seti's sandbox proxy swaps in the real values, so calls with them fail outside the sandbox"
  return `Connections: ${list} hold Seti placeholders: ${swap}. Never print env values or ask for the keys.`
}
