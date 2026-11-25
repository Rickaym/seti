import type { DreamProposal, DreamProposalAnyKind, TrashItem } from '@seti/shared'
import { now, sql } from '../db.js'

type ProposalRow = Omit<DreamProposal, 'bytes'> & { bytes: number | string; subject: string | null }
type TrashRow = Omit<TrashItem, 'bytes'> & { bytes: number | string; trash_path: string; meta: TrashMeta }

/** What a restore needs besides the folder: the branch and its tip, for branches and worktrees. */
export interface TrashMeta {
  repo?: string
  branch?: string
  tip?: string
}

const toProposal = ({ subject: _subject, ...row }: ProposalRow): DreamProposal => ({ ...row, bytes: Number(row.bytes) })

/** A proposal to file: a clean-up, or an unsubscribe with the subscription it names as subject. */
export interface NewProposal {
  kind: DreamProposalAnyKind
  target: string
  reason: string
  subject?: string
}
const toTrash = ({ trash_path: _path, meta: _meta, ...row }: TrashRow): TrashItem => ({
  ...row,
  bytes: Number(row.bytes),
})

/** The most proposals one dream may file (`dream_proposals`). */
export const PROPOSALS_PER_DREAM = 10

export const dreamProposals = {
  add: async (run: { id: number; task_id: string }, input: NewProposal, bytes: number) => {
    const [row] = await sql<ProposalRow[]>`INSERT INTO dream_proposal
        (run_id, task_id, kind, target, reason, bytes, state, created_at, subject)
      VALUES (${run.id}, ${run.task_id}, ${input.kind}, ${input.target}, ${input.reason}, ${bytes}, 'pending', ${now()},
        ${input.subject ?? null})
      RETURNING *`
    if (row === undefined) {
      throw new Error('The proposal was not stored')
    }
    return toProposal(row)
  },
  get: async (id: number) => {
    const [row] = await sql<ProposalRow[]>`SELECT * FROM dream_proposal WHERE id = ${id}`
    return row && { ...toProposal(row), subject: row.subject }
  },
  countForRun: async (runId: number): Promise<number> => {
    const [row] = await sql<{ count: string }[]>`SELECT COUNT(*) AS count FROM dream_proposal WHERE run_id = ${runId}`
    return Number(row?.count ?? 0)
  },
  /** Pending proposals, of one agent or of all, oldest first. */
  pending: async (taskId?: string) =>
    (
      await sql<ProposalRow[]>`SELECT * FROM dream_proposal WHERE state = 'pending'
        AND (${taskId ?? null}::text IS NULL OR task_id = ${taskId ?? null}) ORDER BY id`
    ).map(toProposal),
  /** The proposals of one dream, oldest first. */
  ofRun: async (runId: number) =>
    (await sql<ProposalRow[]>`SELECT * FROM dream_proposal WHERE run_id = ${runId} ORDER BY id`).map(toProposal),
  decide: async (id: number, state: DreamProposal['state'], detail: string | null) => {
    const [row] = await sql<ProposalRow[]>`UPDATE dream_proposal SET state = ${state}, detail = ${detail},
        decided_at = ${now()} WHERE id = ${id} AND state = 'pending' RETURNING *`
    return row && toProposal(row)
  },
  /** Marks pending proposals older than an instant as expired. */
  expire: async (before: string): Promise<number> => {
    const rows = await sql`UPDATE dream_proposal SET state = 'expired', decided_at = ${now()}
      WHERE state = 'pending' AND created_at < ${before} RETURNING id`
    return rows.length
  },
}

export const trashItems = {
  add: async (item: Omit<TrashItem, 'id' | 'created_at' | 'restored_at'> & { trash_path: string; meta: TrashMeta }) => {
    const [row] = await sql<TrashRow[]>`INSERT INTO trash_item
        (task_id, proposal_id, kind, original_path, trash_path, bytes, meta, created_at, purge_after)
      VALUES (${item.task_id}, ${item.proposal_id}, ${item.kind}, ${item.original_path}, ${item.trash_path},
        ${item.bytes}, ${sql.json({ ...item.meta })}, ${now()}, ${item.purge_after}) RETURNING *`
    if (row === undefined) {
      throw new Error('The trash item was not stored')
    }
    return toTrash(row)
  },
  /** An item with where it lies and what restoring it needs. */
  get: async (id: number) => {
    const [row] = await sql<TrashRow[]>`SELECT * FROM trash_item WHERE id = ${id}`
    return row && { item: toTrash(row), trashPath: row.trash_path, meta: row.meta }
  },
  /** Items still in the trash, newest first. */
  list: async () =>
    (
      await sql<TrashRow[]>`SELECT * FROM trash_item WHERE restored_at IS NULL AND purged_at IS NULL
        ORDER BY id DESC`
    ).map(toTrash),
  /** Items still in the trash whose keep ended before an instant, or every one. */
  due: async (before: string | null) =>
    sql<TrashRow[]>`SELECT * FROM trash_item WHERE restored_at IS NULL AND purged_at IS NULL
      AND (${before}::text IS NULL OR purge_after < ${before}) ORDER BY id`,
  restored: async (id: number): Promise<void> => {
    await sql`UPDATE trash_item SET restored_at = ${now()} WHERE id = ${id}`
  },
  purged: async (id: number): Promise<void> => {
    await sql`UPDATE trash_item SET purged_at = ${now()} WHERE id = ${id}`
  },
}
