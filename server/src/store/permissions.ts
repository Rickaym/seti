import {
  DEFAULT_PERMISSION_TIMEOUT_MINUTES,
  PERMISSION_TIMEOUT_MINUTES,
  type PermissionBehavior,
  type PermissionRequest,
  type PermissionRequestState,
  type PermissionRule,
  type PermissionTimeoutMinutes,
  timeoutAt,
  type PermissionTimeoutSettings,
} from '@seti/shared'
import { now, sql } from '../db.js'

/** A request as Seti records it before the user answers. */
export type NewPermissionRequest = Pick<
  PermissionRequest,
  'id' | 'task_id' | 'tool_name' | 'kind' | 'summary' | 'input' | 'reason' | 'suggestions' | 'editable'
> & {
  /** A hash of the exact call, which an answer given after a restart allows once. */
  input_hash?: string
  /** Minutes until Seti denies it unanswered; 0 never does. */
  timeout_minutes: number
}

type RequestRecord = Omit<PermissionRequest, 'suggestions'> & { suggestions: string; input_hash: string | null }

function readSuggestions(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : []
  } catch {
    return []
  }
}

const toRequest = ({ input_hash: _hash, ...row }: RequestRecord): PermissionRequest => ({
  ...row,
  suggestions: readSuggestions(row.suggestions),
})

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
    const at = now()
    const [row] = await sql<RequestRecord[]>`INSERT INTO permission_request
      (id, task_id, tool_name, kind, summary, input, reason, suggestions, editable, state, created_at,
        timeout_at, input_hash)
      VALUES (${request.id}, ${request.task_id}, ${request.tool_name}, ${request.kind}, ${request.summary},
        ${request.input}, ${request.reason}, ${JSON.stringify(request.suggestions)}, ${request.editable},
        'pending', ${at}, ${timeoutAt(at, request.timeout_minutes)}, ${request.input_hash ?? null}) RETURNING *`
    if (row === undefined) {
      throw new Error('The permission request was not recorded')
    }
    return toRequest(row)
  },
  get: async (id: string): Promise<PermissionRequest | undefined> =>
    requests(await sql<RequestRecord[]>`SELECT * FROM permission_request WHERE id = ${id}`).at(0),
  /**
   * Settles a pending request, with the input the call runs with when the user edited it;
   * undefined when it was not pending any more.
   */
  settle: async (
    id: string,
    state: Exclude<PermissionRequestState, 'pending'>,
    message: string | null,
    input?: string,
  ): Promise<PermissionRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`UPDATE permission_request
        SET state = ${state}, message = ${message}, decided_at = ${now()}, input = COALESCE(${input ?? null}, input)
        WHERE id = ${id} AND state = 'pending' RETURNING *`,
    ).at(0),
  /** Denies a pending request whose time ran out by `at`; undefined when it was answered or retimed. */
  timeOut: async (id: string, at: string): Promise<PermissionRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`UPDATE permission_request SET state = 'denied', timed_out = true, decided_at = ${at}
        WHERE id = ${id} AND state = 'pending' AND timeout_at <= ${at} RETURNING *`,
    ).at(0),
  /** Moves a pending request's deadline; undefined when it is not pending any more. */
  retime: async (id: string, deadline: string | null): Promise<PermissionRequest | undefined> =>
    requests(
      await sql<RequestRecord[]>`UPDATE permission_request SET timeout_at = ${deadline}
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
  /**
   * The pending requests a restart left with no call waiting, which can no longer be edited since
   * their input went with the process; returns each with its task.
   */
  orphan: async (waited: readonly string[]): Promise<{ id: string; task_id: string }[]> =>
    (
      await sql<{ id: string; task_id: string }[]>`UPDATE permission_request SET editable = false
        WHERE state = 'pending' AND id <> ALL(${waited}::text[]) RETURNING id, task_id`
    ).map((row) => ({ ...row })),
  /** The hash of the request's exact call; null for one recorded before hashes. */
  hashOf: async (id: string): Promise<string | null> =>
    (await sql<{ input_hash: string | null }[]>`SELECT input_hash FROM permission_request WHERE id = ${id}`).at(0)
      ?.input_hash ?? null,
}

const knownMinutes = (value: number): PermissionTimeoutMinutes =>
  PERMISSION_TIMEOUT_MINUTES.find((minutes) => minutes === value) ?? DEFAULT_PERMISSION_TIMEOUT_MINUTES

export const timeoutSettings = {
  get: async (): Promise<PermissionTimeoutSettings> => {
    const [row] = await sql<{ request_timeout_minutes: number; updated_at: string }[]>`SELECT
      request_timeout_minutes, updated_at FROM permission_settings WHERE id = 1`
    return row === undefined
      ? { request_timeout_minutes: DEFAULT_PERMISSION_TIMEOUT_MINUTES, updated_at: null }
      : { request_timeout_minutes: knownMinutes(row.request_timeout_minutes), updated_at: row.updated_at }
  },
  set: async (minutes: PermissionTimeoutMinutes): Promise<PermissionTimeoutSettings> => {
    const at = now()
    await sql`INSERT INTO permission_settings (id, request_timeout_minutes, updated_at) VALUES (1, ${minutes}, ${at})
      ON CONFLICT (id) DO UPDATE SET request_timeout_minutes = excluded.request_timeout_minutes,
        updated_at = excluded.updated_at`
    return { request_timeout_minutes: minutes, updated_at: at }
  },
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
