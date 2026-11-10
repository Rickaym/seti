import type { PermissionBehavior, PermissionRequest, PermissionRequestState, PermissionRule } from '@seti/shared'
import { now, sql } from '../db.js'

/** A request as Seti records it before the user answers. */
export type NewPermissionRequest = Pick<
  PermissionRequest,
  'id' | 'task_id' | 'tool_name' | 'kind' | 'summary' | 'input' | 'reason' | 'suggestions'
>

type RequestRecord = Omit<PermissionRequest, 'suggestions'> & { suggestions: string }

function readSuggestions(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const toRequest = (row: RequestRecord): PermissionRequest => ({ ...row, suggestions: readSuggestions(row.suggestions) })

const requests = (rows: readonly RequestRecord[]) => rows.map(toRequest)

export const permissionRules = {
  /** Every agent's rules with `taskId` null, else that agent's own, oldest first. */
  list: async (taskId: string | null): Promise<PermissionRule[]> => [
    ...(taskId === null
      ? await sql<PermissionRule[]>`SELECT * FROM permission_rule WHERE task_id IS NULL ORDER BY id`
      : await sql<PermissionRule[]>`SELECT * FROM permission_rule WHERE task_id = ${taskId} ORDER BY id`),
  ],
  /** Adds the rule, or returns the same one already there with false. */
  add: async (
    taskId: string | null,
    behavior: PermissionBehavior,
    rule: string,
  ): Promise<{ rule: PermissionRule; added: boolean }> => {
    const [added] = await sql<PermissionRule[]>`INSERT INTO permission_rule (task_id, behavior, rule, created_at)
      VALUES (${taskId}, ${behavior}, ${rule}, ${now()}) ON CONFLICT DO NOTHING RETURNING *`
    if (added !== undefined) {
      return { rule: added, added: true }
    }
    const [existing] = await sql<PermissionRule[]>`SELECT * FROM permission_rule
      WHERE COALESCE(task_id, '') = ${taskId ?? ''} AND behavior = ${behavior} AND rule = ${rule}`
    if (existing === undefined) {
      throw new Error('The rule was not recorded')
    }
    return { rule: existing, added: false }
  },
  /** Removes the rule of that scope; returns it, or undefined when there was none. */
  remove: async (taskId: string | null, id: number): Promise<PermissionRule | undefined> =>
    (
      await sql<PermissionRule[]>`DELETE FROM permission_rule
        WHERE id = ${id} AND COALESCE(task_id, '') = ${taskId ?? ''} RETURNING *`
    ).at(0),
}

export const permissionRequests = {
  open: async (request: NewPermissionRequest): Promise<PermissionRequest> => {
    const [row] = await sql<RequestRecord[]>`INSERT INTO permission_request
      (id, task_id, tool_name, kind, summary, input, reason, suggestions, state, created_at)
      VALUES (${request.id}, ${request.task_id}, ${request.tool_name}, ${request.kind}, ${request.summary},
        ${request.input},
        ${request.reason}, ${JSON.stringify(request.suggestions)}, 'pending', ${now()}) RETURNING *`
    if (row === undefined) {
      throw new Error('The permission request was not recorded')
    }
    return toRequest(row)
  },
  get: async (id: string): Promise<PermissionRequest | undefined> =>
    requests(await sql<RequestRecord[]>`SELECT * FROM permission_request WHERE id = ${id}`).at(0),
  /** Settles a pending request; undefined when it was not pending any more. */
  settle: async (
    id: string,
    state: Exclude<PermissionRequestState, 'pending'>,
    message: string | null,
  ): Promise<PermissionRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`UPDATE permission_request
        SET state = ${state}, message = ${message}, decided_at = ${now()}
        WHERE id = ${id} AND state = 'pending' RETURNING *`,
    ).at(0),
  /** The agent's pending requests, oldest first. */
  pending: async (taskId: string): Promise<PermissionRequest[]> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM permission_request
        WHERE task_id = ${taskId} AND state = 'pending' ORDER BY created_at, id`,
    ),
  /** Every agent's pending requests, oldest first. */
  allPending: async (): Promise<PermissionRequest[]> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM permission_request WHERE state = 'pending' ORDER BY created_at, id`,
    ),
  /** The agent's latest requests, newest first. */
  recent: async (taskId: string, limit: number): Promise<PermissionRequest[]> =>
    requests(
      await sql<RequestRecord[]>`SELECT * FROM permission_request
        WHERE task_id = ${taskId} ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
    ),
  /** Drops every pending request, as at startup when no process waits on one; returns their ids. */
  cancelAll: async (): Promise<string[]> =>
    (
      await sql<{ id: string }[]>`UPDATE permission_request SET state = 'cancelled', decided_at = ${now()}
        WHERE state = 'pending' RETURNING id`
    ).map((row) => row.id),
}

export const bypass = {
  set: async (taskId: string, until: string | null): Promise<void> => {
    await sql`UPDATE task SET bypass_until = ${until} WHERE id = ${taskId}`
  },
  /** Ends a Bypass that ran out, unless the user changed it since; true when this ended it. */
  end: async (taskId: string, until: string): Promise<boolean> =>
    (await sql`UPDATE task SET bypass_until = NULL WHERE id = ${taskId} AND bypass_until = ${until}`).count > 0,
  /** Every agent with Bypass set, ended or not, as at startup. */
  all: async (): Promise<{ id: string; bypass_until: string }[]> =>
    sql<{ id: string; bypass_until: string }[]>`SELECT id, bypass_until FROM task WHERE bypass_until IS NOT NULL`,
}
