import { sql } from '../db.js'
import { storedJson } from '../stored-rows.js'

export type SendKind = 'task_message' | 'task_start' | 'team_post' | 'ea_chat'

/** One send as the client names it: what it does, to which target, under which id. */
export interface SendKey {
  kind: SendKind
  target: string
  clientId: string
}

/** Run it now, wait for the request already running it, or take the result it stored. */
export type SendClaim<T> = { state: 'run' } | { state: 'pending' } | { state: 'done'; result: T }

interface ClaimRow {
  done: boolean
  result: string | null
}

export const clientSends = {
  /**
   * Claims the send for `owner`; an expired claim, or one left pending by another process,
   * is taken over. The primary key makes one of two concurrent claims win.
   */
  claim: async <T>(key: SendKey, owner: string, at: string, expired: string): Promise<SendClaim<T>> => {
    const taken = await sql`INSERT INTO client_send (kind, target, client_id, owner, created_at)
      VALUES (${key.kind}, ${key.target}, ${key.clientId}, ${owner}, ${at})
      ON CONFLICT (kind, target, client_id) DO UPDATE
        SET owner = EXCLUDED.owner, created_at = EXCLUDED.created_at, result = NULL, done = false
        WHERE client_send.created_at < ${expired} OR (NOT client_send.done AND client_send.owner <> ${owner})
      RETURNING kind`
    if (taken.length > 0) {
      return { state: 'run' }
    }
    const [row] = await sql<ClaimRow[]>`SELECT done, result FROM client_send
      WHERE kind = ${key.kind} AND target = ${key.target} AND client_id = ${key.clientId}`
    return row?.done === true ? { state: 'done', result: JSON.parse(row.result ?? 'null') as T } : { state: 'pending' }
  },
  finish: async (key: SendKey, result: unknown): Promise<void> => {
    await sql`UPDATE client_send SET done = true, result = ${storedJson(result)}
      WHERE kind = ${key.kind} AND target = ${key.target} AND client_id = ${key.clientId}`
  },
  /** Drops a claim whose send failed, so a retry runs it again. */
  release: async (key: SendKey): Promise<void> => {
    await sql`DELETE FROM client_send
      WHERE kind = ${key.kind} AND target = ${key.target} AND client_id = ${key.clientId} AND NOT done`
  },
  prune: async (expired: string): Promise<void> => {
    await sql`DELETE FROM client_send WHERE created_at < ${expired}`
  },
}
