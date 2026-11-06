import { sql } from '../db.js'

/** Assistant message errors that mean the login or its billing is broken, not a transient failure. */
const LOGIN_ERRORS = [
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'verification_required',
  'billing_error',
  'cloud_credential_error',
]

export interface StoredTaskMessage {
  task_id: string
  task_title: string
  created_at: string
  payload: string
}

/** The JSON expressions match the partial indexes on task_message word for word. */
export const accountSignals = {
  recentRateLimitEvents: async (limit: number) =>
    sql<StoredTaskMessage[]>`SELECT m.task_id, t.title AS task_title, m.created_at, m.payload
      FROM task_message m JOIN task t ON t.id = m.task_id
      WHERE m.kind = 'sdk' AND (m.payload::json ->> 'type') = 'rate_limit_event' ORDER BY m.id DESC LIMIT ${limit}`,
  latestLoginFailure: async () =>
    (
      await sql<StoredTaskMessage[]>`SELECT m.task_id, t.title AS task_title, m.created_at, m.payload
        FROM task_message m JOIN task t ON t.id = m.task_id
        WHERE m.kind = 'sdk'
          AND ((m.payload::json ->> 'error') IS NOT NULL OR (m.payload::json ->> 'api_error_status') IS NOT NULL)
          AND (((m.payload::json ->> 'type') = 'assistant' AND (m.payload::json ->> 'error') = ANY(${LOGIN_ERRORS}))
            OR ((m.payload::json ->> 'type') = 'result' AND (m.payload::json ->> 'is_error') = 'true'
                AND (m.payload::json ->> 'api_error_status') IN ('401', '403')))
        ORDER BY m.id DESC LIMIT 1`
    ).at(0),
  latestSuccessAt: async () =>
    (
      await sql<{ created_at: string }[]>`SELECT created_at FROM task_message
        WHERE kind = 'sdk' AND (payload::json ->> 'type') = 'result' AND (payload::json ->> 'is_error') = 'false'
        ORDER BY id DESC LIMIT 1`
    ).at(0)?.created_at ?? null,
}
