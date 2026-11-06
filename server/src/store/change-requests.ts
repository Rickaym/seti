import { hostFlags, type ChangeRequest, type ChangeState, type HostScope, type RequestedChange } from '@seti/shared'
import { now, sql } from '../db.js'
import { sandboxPolicy } from './sandbox.js'

type RequestRecord = Omit<ChangeRequest, 'change' | 'flags'> & { change: string; change_key: string }

const flagsOf = (change: RequestedChange) => (change.kind === 'allow_host' ? hostFlags(change.host) : [])

function toRequest({ change: text, change_key: _key, ...row }: RequestRecord): ChangeRequest {
  const change = JSON.parse(text) as RequestedChange
  return { ...row, change, flags: flagsOf(change) }
}

const requests = (rows: readonly RequestRecord[]) => rows.map(toRequest)

/** One string per distinct change, so the same change asked twice while pending is one request. */
const changeKey = (change: RequestedChange) => JSON.stringify(change)

export interface NewChangeRequest {
  id: string
  task_id: string
  change: RequestedChange
  reason: string
  profile_id: string
  expires_at: string
}

export const changeRequests = {
  /** Records the request; undefined when the same change already waits for this agent. */
  open: async (request: NewChangeRequest): Promise<ChangeRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`INSERT INTO change_request
        (id, task_id, change, change_key, reason, profile_id, state, created_at, expires_at)
        VALUES (${request.id}, ${request.task_id}, ${JSON.stringify(request.change)}, ${changeKey(request.change)},
          ${request.reason}, ${request.profile_id}, 'pending', ${now()}, ${request.expires_at})
        ON CONFLICT DO NOTHING RETURNING *`,
    ).at(0),
  get: async (id: string): Promise<ChangeRequest | undefined> =>
    requests(await sql<RequestRecord[]>`SELECT * FROM change_request WHERE id = ${id}`).at(0),
  /** The pending request of this agent for the same change, if any. */
  pendingSame: async (taskId: string, change: RequestedChange): Promise<ChangeRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM change_request
        WHERE task_id = ${taskId} AND change_key = ${changeKey(change)} AND state = 'pending'`,
    ).at(0),
  /** The agent's pending requests, oldest first. */
  pending: async (taskId: string): Promise<ChangeRequest[]> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM change_request
        WHERE task_id = ${taskId} AND state = 'pending' ORDER BY created_at, id`,
    ),
  /** Pending API key requests of agents on the credential for the variable. */
  pendingKeys: async (profileId: string, env: string): Promise<ChangeRequest[]> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM change_request
        WHERE state = 'pending' AND profile_id = ${profileId}
          AND (change::json ->> 'kind') = 'api_key' AND (change::json ->> 'env') = ${env}
        ORDER BY created_at, id`,
    ),
  /** How many requests the agent made since `since`, answered or not. */
  countSince: async (taskId: string, since: string): Promise<number> => {
    const [row] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM change_request
      WHERE task_id = ${taskId} AND created_at >= ${since}`
    return Number(row?.count ?? 0)
  },
  /** Settles a pending request; undefined when it was not pending any more. */
  settle: async (id: string, state: Exclude<ChangeState, 'pending'>, scope: HostScope | null = null) =>
    requests(
      await sql<RequestRecord[]>`UPDATE change_request
        SET state = ${state}, scope = ${scope}, answered_at = ${now()}
        WHERE id = ${id} AND state = 'pending' RETURNING *`,
    ).at(0),
  /** Marks every pending request past its expiry expired and returns them. */
  expireDue: async (at: string): Promise<ChangeRequest[]> =>
    requests(
      await sql<RequestRecord[]>`UPDATE change_request SET state = 'expired', answered_at = ${at}
        WHERE state = 'pending' AND expires_at <= ${at} RETURNING *`,
    ),
}

export const taskHosts = {
  /** The allowlist entries the user added for this agent alone, oldest first. */
  list: async (taskId: string): Promise<string[]> =>
    (
      await sql<{ entry: string }[]>`SELECT entry FROM task_allowed_host
        WHERE task_id = ${taskId} ORDER BY added_at, entry`
    ).map((row) => row.entry),
  /** Adds the entry; false when the agent had it already. */
  add: async (taskId: string, entry: string): Promise<boolean> =>
    (
      await sql`INSERT INTO task_allowed_host (task_id, entry, added_at)
        VALUES (${taskId}, ${entry}, ${now()}) ON CONFLICT DO NOTHING`
    ).count > 0,
  /** Removes the entry; false when the agent did not have it. */
  remove: async (taskId: string, entry: string): Promise<boolean> =>
    (await sql`DELETE FROM task_allowed_host WHERE task_id = ${taskId} AND entry = ${entry}`).count > 0,
}

/** Every allowlist entry a task's proxy lets through: the shared list, then its own. */
export async function allowedFor(taskId: string): Promise<string[]> {
  return [...(await sandboxPolicy.get()).allowed_domains, ...(await taskHosts.list(taskId))]
}
