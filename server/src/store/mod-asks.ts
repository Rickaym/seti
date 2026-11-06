import type { ModAsk, ModAskDecision, ModAskOp, ModAskState } from '@seti/shared'
import { sql } from '../db.js'

interface AskRecord {
  id: string
  mod_id: string
  op: ModAskOp
  args: Record<string, unknown>
  summary: string
  created_at: string
  expires_at: string
  decision: ModAskDecision | null
  decided_at: string | null
  outcome: 'done' | 'failed' | null
  detail: { text?: string } | null
}

function stateOf(row: AskRecord, at: string): ModAskState {
  if (row.outcome !== null) {
    return row.outcome
  }
  if (row.decision !== null) {
    return row.decision === 'allow' ? 'allowed' : 'denied'
  }
  return row.expires_at > at ? 'pending' : 'expired'
}

const toAsk = (row: AskRecord, at: string): ModAsk => ({
  id: row.id,
  mod_id: row.mod_id,
  op: row.op,
  summary: row.summary,
  args: row.args,
  created_at: row.created_at,
  expires_at: row.expires_at,
  state: stateOf(row, at),
  decided_at: row.decided_at,
  outcome: row.detail?.text ?? null,
})

/** A new ask, as Seti records it from the mod's call. */
interface NewModAsk {
  id: string
  mod_id: string
  op: ModAskOp
  args: Record<string, unknown>
  summary: string
  created_at: string
  expires_at: string
}

type DecideResult = { ok: true; ask: ModAsk } | { ok: false; state: ModAskState | null }

/** What mods asked the user to allow; only the user's own answer runs one. */
export const modAsks = {
  add: async (ask: NewModAsk): Promise<ModAsk> => {
    const [row] = await sql<AskRecord[]>`INSERT INTO mod_ask (id, mod_id, op, args, summary, created_at, expires_at)
      VALUES (${ask.id}, ${ask.mod_id}, ${ask.op}, ${JSON.stringify(ask.args)}::text::jsonb, ${ask.summary},
        ${ask.created_at}, ${ask.expires_at})
      RETURNING *`
    if (row === undefined) {
      throw new Error('The mod ask was not recorded')
    }
    return toAsk(row, ask.created_at)
  },
  /** Asks of the mod still waiting for the user. */
  openCount: async (modId: string, at: string): Promise<number> => {
    const [row] = await sql<{ count: string }[]>`SELECT count(*) AS count FROM mod_ask
      WHERE mod_id = ${modId} AND decision IS NULL AND expires_at > ${at}`
    return Number(row?.count ?? 0)
  },
  /** Every ask still waiting for the user, oldest first. */
  open: async (at: string): Promise<ModAsk[]> =>
    (
      await sql<AskRecord[]>`SELECT * FROM mod_ask WHERE decision IS NULL AND expires_at > ${at}
        ORDER BY created_at, id`
    ).map((row) => toAsk(row, at)),
  get: async (id: string, at: string): Promise<ModAsk | undefined> => {
    const [row] = await sql<AskRecord[]>`SELECT * FROM mod_ask WHERE id = ${id}`
    return row && toAsk(row, at)
  },
  /** Records the one answer an open ask takes; a second answer or a late one changes nothing. */
  decide: async (id: string, decision: ModAskDecision, at: string): Promise<DecideResult> => {
    const [row] = await sql<AskRecord[]>`UPDATE mod_ask SET decision = ${decision}, decided_at = ${at}
      WHERE id = ${id} AND decision IS NULL AND expires_at > ${at} RETURNING *`
    if (row !== undefined) {
      return { ok: true, ask: toAsk(row, at) }
    }
    const [current] = await sql<AskRecord[]>`SELECT * FROM mod_ask WHERE id = ${id}`
    return { ok: false, state: current === undefined ? null : stateOf(current, at) }
  },
  finish: async (id: string, outcome: 'done' | 'failed', text: string): Promise<void> => {
    await sql`UPDATE mod_ask SET outcome = ${outcome}, detail = ${JSON.stringify({ text })}::text::jsonb
      WHERE id = ${id} AND decision = 'allow' AND outcome IS NULL`
  },
}
