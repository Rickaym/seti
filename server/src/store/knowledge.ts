import {
  KNOWLEDGE_FAILURES_TO_STALE,
  KNOWLEDGE_FRESH_DAYS,
  KNOWLEDGE_KINDS,
  type KnowledgeFields,
  type KnowledgeNote,
  type KnowledgeProposer,
  type KnowledgeSource,
  type KnowledgeStatus,
  type KnowledgeSummary,
} from '@seti/shared'
import { now, sql } from '../db.js'

type NoteRecord = Omit<KnowledgeNote, 'sources'> & { sources: string }

const LIST_LIMIT = 200
const DAY_MS = 86_400_000

function toNote(record: NoteRecord): KnowledgeNote {
  const parsed = JSON.parse(record.sources) as unknown
  return { ...record, sources: Array.isArray(parsed) ? (parsed as KnowledgeSource[]) : [] }
}

const notes = (rows: readonly NoteRecord[]) => rows.map(toNote)

const SELECT = sql`SELECT n.id, n.kind, n.title, n.body, n.verify, n.sources, n.repo_id, r.slug AS repo_slug,
    n.status, n.proposer, n.proposer_task_id, n.proposer_title, n.corrects_id, n.failures, n.verified_count,
    n.last_verified_at, n.decided_at, n.status_reason, n.created_at, n.updated_at
  FROM knowledge_note n LEFT JOIN repo r ON r.id = n.repo_id`

/** Notes an agent sees: global ones and those of its repos; null means every note. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- a fragment, never awaited
const inScope = (repoIds: readonly string[] | null) =>
  repoIds === null ? sql`TRUE` : sql`(n.repo_id IS NULL OR n.repo_id = ANY(${[...repoIds]}))`

export interface NewNote extends KnowledgeFields {
  id: string
  proposer: KnowledgeProposer
  proposer_task_id: string | null
  proposer_title: string | null
  corrects_id: string | null
}

/** What one check did to a note, and whether it took the note out of the index just now. */
export interface CheckOutcome {
  note: KnowledgeNote
  wentStale: boolean
  restored: boolean
}

const get = async (id: string) => notes(await sql<NoteRecord[]>`${SELECT} WHERE n.id = ${id}`).at(0)

const required = async (id: string) => {
  const note = await get(id)
  if (note === undefined) {
    throw new Error(`Knowledge note ${id} was not stored`)
  }
  return note
}

export const knowledge = {
  insert: async (note: NewNote): Promise<KnowledgeNote> => {
    const at = now()
    await sql`INSERT INTO knowledge_note (id, kind, title, body, verify, sources, repo_id, status, proposer,
        proposer_task_id, proposer_title, corrects_id, created_at, updated_at)
      VALUES (${note.id}, ${note.kind}, ${note.title}, ${note.body}, ${note.verify}, ${JSON.stringify(note.sources)},
        ${note.repo_id}, 'proposed', ${note.proposer}, ${note.proposer_task_id}, ${note.proposer_title},
        ${note.corrects_id}, ${at}, ${at})`
    return required(note.id)
  },
  get,
  /** Notes in one status, the most recently changed first. */
  list: async (status: KnowledgeStatus): Promise<KnowledgeNote[]> =>
    notes(await sql<NoteRecord[]>`${SELECT} WHERE n.status = ${status} ORDER BY n.updated_at DESC LIMIT ${LIST_LIMIT}`),
  summary: async (): Promise<KnowledgeSummary> => {
    const [row] = await sql<{ proposed: string; stale: string }[]>`SELECT
        COUNT(*) FILTER (WHERE status = 'proposed') AS proposed, COUNT(*) FILTER (WHERE status = 'stale') AS stale
      FROM knowledge_note`
    return { proposed: Number(row?.proposed ?? 0), stale: Number(row?.stale ?? 0) }
  },
  /** How many of the agent's proposals wait for the user. */
  waitingFrom: async (taskId: string): Promise<number> => {
    const [row] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM knowledge_note
      WHERE proposer_task_id = ${taskId} AND status = 'proposed'`
    return Number(row?.count ?? 0)
  },
  /** The open correction of a note, so repeated failures file it once. */
  openCorrection: async (id: string) =>
    notes(await sql<NoteRecord[]>`${SELECT} WHERE n.corrects_id = ${id} AND n.status = 'proposed'`).at(0),
  setFields: async (id: string, fields: KnowledgeFields): Promise<KnowledgeNote> => {
    await sql`UPDATE knowledge_note SET kind = ${fields.kind}, title = ${fields.title}, body = ${fields.body},
        verify = ${fields.verify}, sources = ${JSON.stringify(fields.sources)}, repo_id = ${fields.repo_id},
        updated_at = ${now()}
      WHERE id = ${id}`
    return required(id)
  },
  /**
   * Moves a note from one of `from` to `to`; undefined when it was in none of them. Approval
   * counts as a passed check, so an approved note starts fresh.
   */
  decide: async (
    id: string,
    from: readonly KnowledgeStatus[],
    to: KnowledgeStatus,
    reason: string | null,
  ): Promise<KnowledgeNote | undefined> => {
    const at = now()
    const fresh = to === 'approved'
    const rows = await sql<{ id: string }[]>`UPDATE knowledge_note SET status = ${to}, status_reason = ${reason},
        decided_at = ${at}, updated_at = ${at},
        failures = CASE WHEN ${fresh} THEN 0 ELSE failures END,
        last_verified_at = CASE WHEN ${fresh} THEN ${at} ELSE last_verified_at END
      WHERE id = ${id} AND status = ANY(${[...from]}) RETURNING id`
    return rows.length === 0 ? undefined : required(id)
  },
  /**
   * Records one check of an approved or stale note. A pass makes it fresh and brings a stale one
   * back; enough failures in a row make an approved one stale.
   */
  check: async (id: string, passed: boolean): Promise<CheckOutcome | undefined> => {
    const at = now()
    const [row] = await sql<{ was: KnowledgeStatus; status: KnowledgeStatus }[]>`
      WITH old AS (SELECT status FROM knowledge_note WHERE id = ${id} AND status IN ('approved', 'stale') FOR UPDATE)
      UPDATE knowledge_note n SET
        failures = CASE WHEN ${passed} THEN 0 ELSE n.failures + 1 END,
        verified_count = n.verified_count + CASE WHEN ${passed} THEN 1 ELSE 0 END,
        last_verified_at = CASE WHEN ${passed} THEN ${at} ELSE n.last_verified_at END,
        status = CASE
          WHEN ${passed} THEN 'approved'
          WHEN n.failures + 1 >= ${KNOWLEDGE_FAILURES_TO_STALE} THEN 'stale'
          ELSE n.status END,
        status_reason = CASE
          WHEN ${passed} THEN NULL
          WHEN n.status = 'approved' AND n.failures + 1 >= ${KNOWLEDGE_FAILURES_TO_STALE}
            THEN ${`Its check failed ${String(KNOWLEDGE_FAILURES_TO_STALE)} times in a row`}
          ELSE n.status_reason END,
        updated_at = ${at}
      FROM old WHERE n.id = ${id}
      RETURNING old.status AS was, n.status`
    if (row === undefined) {
      return undefined
    }
    const note = await required(id)
    return {
      note,
      wentStale: row.was === 'approved' && row.status === 'stale',
      restored: row.was === 'stale' && passed,
    }
  },
  /** Marks every approved note whose last passed check is older than its kind allows stale. */
  markStaleDue: async (at = Date.now()): Promise<KnowledgeNote[]> => {
    const stamp = new Date(at).toISOString()
    const updated: KnowledgeNote[] = []
    for (const kind of KNOWLEDGE_KINDS) {
      const days = KNOWLEDGE_FRESH_DAYS[kind]
      const cutoff = new Date(at - days * DAY_MS).toISOString()
      const rows = await sql<{ id: string }[]>`UPDATE knowledge_note SET status = 'stale', updated_at = ${stamp},
          status_reason = ${`Not verified in ${String(days)} days`}
        WHERE status = 'approved' AND kind = ${kind} AND last_verified_at < ${cutoff} RETURNING id`
      for (const { id } of rows) {
        updated.push(await required(id))
      }
    }
    return updated
  },
  /** Approved and stale notes in scope whose id starts with the prefix, at most two. */
  byPrefix: async (prefix: string, repoIds: readonly string[] | null): Promise<KnowledgeNote[]> => {
    const pattern = `${prefix}%`
    return notes(
      await sql<NoteRecord[]>`${SELECT} WHERE n.status IN ('approved', 'stale') AND ${inScope(repoIds)}
        AND n.id LIKE ${pattern} ORDER BY n.id LIMIT 2`,
    )
  },
  /** Approved notes for the index: the most recently verified first, then the most verified. */
  indexed: async (repoIds: readonly string[], limit: number): Promise<KnowledgeNote[]> =>
    notes(
      await sql<NoteRecord[]>`${SELECT} WHERE n.status = 'approved' AND ${inScope(repoIds)}
        ORDER BY n.last_verified_at DESC NULLS LAST, n.verified_count DESC, n.id LIMIT ${limit}`,
    ),
  /** Approved and stale notes matching the words, the best match first; with no words, the newest. */
  search: async (query: string, repoIds: readonly string[] | null, limit: number): Promise<KnowledgeNote[]> => {
    const words = query.trim()
    const match = words === '' ? sql`TRUE` : sql`n.tsv @@ websearch_to_tsquery('english', ${words})`
    const rank = words === '' ? sql`0` : sql`ts_rank(n.tsv, websearch_to_tsquery('english', ${words}))`
    return notes(
      await sql<NoteRecord[]>`${SELECT} WHERE n.status IN ('approved', 'stale') AND ${inScope(repoIds)} AND ${match}
        ORDER BY n.status = 'stale', ${rank} DESC, n.last_verified_at DESC NULLS LAST LIMIT ${limit}`,
    )
  },
}
