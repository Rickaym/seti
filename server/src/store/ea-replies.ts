import {
  EA_ASK_TTL_MS,
  type EaAnsweredAsk,
  type EaAsk,
  type EaAskDecision,
  type EaAskConfirmInput,
  type EaAskRecord,
  type EaOpenAsk,
  type EaAskOutcome,
  type EaAskState,
  type EaHistoryAppendInput,
  type EaLlmMessage,
  type EaUnseenReplies,
  type EaUnseenReply,
} from '@seti/shared'
import { sql, transaction, type Db } from '../db.js'

/** A batch the bot appends; `notify` and `asks` may be left out. */
export type AppendBatch = Pick<EaHistoryAppendInput, 'entries'> & Partial<Omit<EaHistoryAppendInput, 'entries'>>

const REPLY_TEXT_MAX = 600
const UNSEEN_PAGE = 20

interface AskRecord {
  id: number
  tool: string
  args: string
  summary: string
  gate_key: string
  ask_epoch: string
  ask_turn: number
  entry_id: number | null
  created_at: string
  expires_at: string
  decision: EaAskDecision | null
  decided_at: string | null
  taken_at: string | null
  outcome: 'done' | 'failed' | null
  detail: string | null
}

function askState(record: Pick<AskRecord, 'decision' | 'outcome' | 'expires_at'>, at: string): EaAskState {
  if (record.outcome !== null) {
    return record.outcome
  }
  if (record.decision !== null) {
    return record.decision === 'allow' ? 'allowed' : 'denied'
  }
  return record.expires_at <= at ? 'expired' : 'pending'
}

const toAsk = (record: AskRecord, at: string): EaAsk => ({
  id: record.id,
  tool: record.tool,
  summary: record.summary,
  state: askState(record, at),
  detail: record.detail,
  expires_at: record.expires_at,
})

const replyText = (message: EaLlmMessage): string =>
  message.role === 'assistant' && typeof message.content === 'string' ? message.content.trim() : ''

const clipped = (text: string) =>
  text.length > REPLY_TEXT_MAX ? `${text.slice(0, REPLY_TEXT_MAX - 3).trimEnd()}...` : text

/**
 * Marks the last reply of a batch the bot stored as unseen, and ties the questions the EA asked
 * in that turn to it. Batches without a written reply leave nothing unseen.
 */
export async function markReply(tx: Db, ids: readonly number[], input: AppendBatch): Promise<void> {
  if (input.notify !== true) {
    return
  }
  const index = input.entries.findLastIndex((entry) => entry.kind === 'chat' && replyText(entry.message) !== '')
  const id = ids[index]
  if (index < 0 || id === undefined) {
    return
  }
  await tx`UPDATE ea_history SET unseen = true WHERE id = ${id}`
  const asks = input.asks ?? []
  if (asks.length > 0) {
    await tx`UPDATE ea_ask SET entry_id = ${id} WHERE id = ANY(${asks}) AND decision IS NULL`
  }
}

interface UnseenRecord {
  id: number
  kind: string
  message: string
  created_at: string
  notice_title: string | null
  notice_body: string | null
}

function textOf(record: UnseenRecord): string {
  if (record.kind === 'inbox') {
    const body = record.notice_body?.trim() ?? ''
    return body === '' ? (record.notice_title ?? '') : `${record.notice_title ?? ''}: ${body}`
  }
  return replyText(JSON.parse(record.message) as EaLlmMessage)
}

/** EA messages that wait for the user, and the questions they ask. */
export const eaReplies = {
  unseen: async (at: string): Promise<EaUnseenReplies> => {
    const rows = await sql<UnseenRecord[]>`SELECT h.id, h.kind, h.message, h.created_at,
        i.title AS notice_title, i.body AS notice_body
      FROM ea_history h LEFT JOIN ea_inbox i ON h.kind = 'inbox' AND i.entry_id = h.id
      WHERE h.unseen ORDER BY h.id DESC LIMIT ${UNSEEN_PAGE}`
    const [count] = await sql<{ total: number }[]>`SELECT COUNT(*)::int AS total FROM ea_history WHERE unseen`
    const ids = rows.map((row) => row.id)
    const asks =
      ids.length === 0 ? [] : await sql<AskRecord[]>`SELECT * FROM ea_ask WHERE entry_id = ANY(${ids}) ORDER BY id`
    const replies = rows.toReversed().map((row): EaUnseenReply => ({
      id: row.id,
      text: clipped(textOf(row)),
      created_at: row.created_at,
      asks: asks.filter((ask) => ask.entry_id === row.id).map((ask) => toAsk(ask, at)),
    }))
    return { replies, total: count?.total ?? 0 }
  },
  /**
   * Marks the named messages seen, or every one up to `through`, and the inbox items shown before
   * them that no unseen message still stands for; returns how many messages were unseen.
   */
  seen: async (target: { ids?: number[] | undefined; through?: number | undefined }, at: string): Promise<number> =>
    transaction(async (tx) => {
      const ids = target.ids ?? []
      const through = target.through ?? 0
      const marked = await tx<{ id: number }[]>`UPDATE ea_history SET unseen = false
        WHERE unseen AND (id = ANY(${ids}::bigint[]) OR id <= ${through}) RETURNING id`
      const last = Math.max(through, ...ids)
      await tx`UPDATE ea_inbox SET acknowledged_at = ${at}
        WHERE delivered_at IS NOT NULL AND acknowledged_at IS NULL AND entry_id <= ${last}
          AND NOT EXISTS (SELECT 1 FROM ea_history h WHERE h.id = ea_inbox.entry_id AND h.unseen)`
      return marked.length
    }),
  /** Marks the entries of delivered inbox items unseen, for items no report of the EA follows. */
  markInbox: async (tx: Db, itemIds: readonly number[]): Promise<void> => {
    if (itemIds.length > 0) {
      await tx`UPDATE ea_history SET unseen = true
        WHERE id IN (SELECT entry_id FROM ea_inbox WHERE id = ANY(${[...itemIds]}) AND entry_id IS NOT NULL)`
    }
  },
}

/** Serialises asking, so one change never has two open questions. */
const EA_ASK_LOCK = 7_412_002

const answered = (rows: readonly AskRecord[]): EaAnsweredAsk[] =>
  rows
    .toSorted((a, b) => a.id - b.id)
    .flatMap((row) =>
      row.decision === null
        ? []
        : [
            {
              id: row.id,
              tool: row.tool,
              args: JSON.parse(row.args) as Record<string, unknown>,
              summary: row.summary,
              decision: row.decision,
            },
          ],
    )

export type DecideResult = { ok: true; ask: AskRecord } | { ok: false; state: EaAskState | null }

/** Questions the EA asks before a tool acts, the user's answers and what came of them. */
export const eaAsks = {
  /** Records a question; asking the same change again while it is open returns the first one. */
  add: async (input: EaAskRecord, at: string): Promise<EaAsk> =>
    transaction(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${EA_ASK_LOCK})`
      const [open] = await tx<AskRecord[]>`SELECT * FROM ea_ask
        WHERE gate_key = ${input.key} AND decision IS NULL AND expires_at > ${at} ORDER BY id DESC LIMIT 1`
      if (open !== undefined) {
        return toAsk(open, at)
      }
      const expires = new Date(Date.parse(at) + EA_ASK_TTL_MS).toISOString()
      const [row] = await tx<AskRecord[]>`INSERT INTO ea_ask (tool, args, summary, gate_key, ask_epoch, ask_turn,
          created_at, expires_at)
        VALUES (${input.tool}, ${JSON.stringify(input.args)}, ${input.summary}, ${input.key}, ${input.epoch},
          ${input.turn}, ${at}, ${expires})
        RETURNING *`
      if (row === undefined) {
        throw new Error('EA question was not recorded')
      }
      return toAsk(row, at)
    }),
  /** Questions still waiting for the user, oldest first. */
  open: async (at: string): Promise<EaOpenAsk[]> => [
    ...(await sql<EaOpenAsk[]>`SELECT id, tool, summary, created_at FROM ea_ask
      WHERE decision IS NULL AND expires_at > ${at} ORDER BY id`),
  ],
  /**
   * The user's yes in the chat or on a call: takes the named open questions that were asked in an
   * earlier turn or an earlier EA process, and returns them with the calls to run.
   */
  confirm: async (input: EaAskConfirmInput, at: string): Promise<EaAnsweredAsk[]> => {
    const rows = await sql<AskRecord[]>`UPDATE ea_ask SET decision = 'allow', decided_at = ${at}, taken_at = ${at}
      WHERE decision IS NULL AND expires_at > ${at}
        AND (ask_epoch <> ${input.epoch} OR ask_turn < ${input.turn})
        AND (id = ANY(${input.ids ?? []}::bigint[]) OR gate_key = ${input.key ?? null})
      RETURNING *`
    return answered(rows)
  },
  get: async (id: number, at: string): Promise<EaAsk | undefined> => {
    const [row] = await sql<AskRecord[]>`SELECT * FROM ea_ask WHERE id = ${id}`
    return row && toAsk(row, at)
  },
  /** Records the answer once, while the question is still open; otherwise says where it stands. */
  decide: async (id: number, decision: EaAskDecision, at: string): Promise<DecideResult> => {
    const [row] = await sql<AskRecord[]>`UPDATE ea_ask SET decision = ${decision}, decided_at = ${at}
      WHERE id = ${id} AND decision IS NULL AND expires_at > ${at} RETURNING *`
    if (row !== undefined) {
      return { ok: true, ask: row }
    }
    const [current] = await sql<AskRecord[]>`SELECT * FROM ea_ask WHERE id = ${id}`
    return { ok: false, state: current === undefined ? null : askState(current, at) }
  },
  /** Answered questions the EA has not taken yet; each goes out once. */
  claim: async (at: string): Promise<EaAnsweredAsk[]> => {
    const rows = await sql<AskRecord[]>`UPDATE ea_ask SET taken_at = ${at}
      WHERE decision IS NOT NULL AND taken_at IS NULL RETURNING *`
    return answered(rows)
  },
  /** What came of an allowed call; undefined when there is no allowed call still open. */
  outcome: async (id: number, input: EaAskOutcome, at: string): Promise<EaAsk | undefined> => {
    const [row] = await sql<AskRecord[]>`UPDATE ea_ask SET outcome = ${input.outcome}, detail = ${input.detail}
      WHERE id = ${id} AND decision = 'allow' AND outcome IS NULL RETURNING *`
    return row && toAsk(row, at)
  },
}
