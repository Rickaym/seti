import { connectionName, firstFree, type Connection, type RequestedChange, type Task } from '@seti/shared'
import { closeRequest } from './change-request-notes.js'
import { createConnectionPlaceholder, setConnectionProfiles, setConnectionValue } from './connections.js'
import { HttpError } from './http.js'
import { changeRequests } from './store/change-requests.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'

type KeyChange = Extract<RequestedChange, { kind: 'api_key' }>

const sameHosts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((host) => b.includes(host))

/** Refuses a pasted key for a connection that already holds one or takes no single key. */
function refuseValueFor(existing: ConnectionRow): void {
  if (existing.kind !== 'key') {
    throw new HttpError(409, `The connection ${existing.name} mints its own tokens; Allow it without a key`)
  }
  if (existing.slots.value !== undefined) {
    throw new HttpError(
      409,
      `The connection ${existing.name} already has its key; Allow without one, or change it in Settings, Connections`,
    )
  }
}

/**
 * The one seam between key requests and connections. Allow puts a connection with the variable
 * and hosts the agent asked for in its credential, with the key the user pasted on the card or
 * with none, for the user to paste in Settings, Connections. A connection that already has the
 * variable joins only on the same hosts, and takes a pasted key only while it has none.
 */
export async function placeKeyRequest(task: Task, change: KeyChange, value?: string): Promise<void> {
  const rows = await connectionRows.list()
  const existing = rows.find((row) => row.env === change.env)
  if (existing !== undefined && !sameHosts(existing.hosts, change.hosts)) {
    throw new HttpError(
      409,
      `The connection ${existing.name} already uses ${change.env} on other hosts; change it in Settings, Connections`,
    )
  }
  if (existing !== undefined && value !== undefined) {
    refuseValueFor(existing)
  }
  const names = new Set(rows.map((row) => row.name))
  const free = (name: string) => !names.has(name) && connectionName.safeParse(name).success
  const name = firstFree(change.env.toLowerCase(), free)
  const target =
    existing ??
    (await createConnectionPlaceholder({ name, env: change.env, hosts: change.hosts, adds_header: false }, 'user'))
  if (value !== undefined) {
    await setConnectionValue(target.id, 'value', value)
  }
  const carriers = (await connectionRows.profilesOf(target.id)).map((profile) => profile.id)
  await setConnectionProfiles(target.id, [...carriers, task.profile_id])
}

/** Whether the agent's credential already gives it the variable. */
export async function hasKey(task: Task, change: KeyChange): Promise<boolean> {
  return (await connectionRows.profileList(task.profile_id)).some((row) => row.env === change.env)
}

/** Allows the key requests a connection answers: the same variable, now in the same credential. */
async function settleKeyRequests(profileId: string, env: string): Promise<void> {
  for (const request of await changeRequests.pendingKeys(profileId, env)) {
    const settled = await changeRequests.settle(request.id, 'allowed')
    if (settled !== undefined) {
      await closeRequest(settled, 'allowed')
    }
  }
}

/** Allows the key requests a connection now answers in each credential that carries it. */
export async function settleConnection(connection: Connection): Promise<Connection> {
  for (const profile of connection.profiles) {
    await settleKeyRequests(profile.id, connection.env)
  }
  return connection
}
