import type {
  Revision,
  RevisionActor,
  RevisionKind,
  RevisionObjectRef,
  RevisionObjectType,
  RevisionState,
  UnseenChange,
} from '@seti/shared'
import { now, sql } from '../db.js'

export interface NewRevision {
  actor: RevisionActor
  task_id: string | null
  object_type: RevisionObjectType
  object_id: string
  before: RevisionState | null
  after: RevisionState | null
  reason: string | null
}

type RevisionRecord = Omit<Revision, 'before' | 'after' | 'kind'> & { before: string | null; after: string | null }

const parseState = (json: string | null) => (json === null ? null : (JSON.parse(json) as RevisionState))

function kindOf(before: RevisionState | null, after: RevisionState | null): RevisionKind {
  if (after === null) {
    return 'note'
  }
  return before === null ? 'created' : 'updated'
}

function toRevision(record: RevisionRecord): Revision {
  const before = parseState(record.before)
  const after = parseState(record.after)
  return { ...record, before, after, kind: kindOf(before, after) }
}

const SELECT = sql`SELECT r.*, t.title AS task_title FROM revision r LEFT JOIN task t ON t.id = r.task_id`

const getRecord = async (id: number) => (await sql<RevisionRecord[]>`${SELECT} WHERE r.id = ${id}`).at(0)

const stateJson = (state: RevisionState | null) => (state === null ? null : JSON.stringify(state))

export const revisions = {
  insert: async (revision: NewRevision): Promise<Revision> => {
    const [row] = await sql<{ id: number }[]>`INSERT INTO revision
        (at, actor, task_id, object_type, object_id, before, after, reason)
      VALUES (${now()}, ${revision.actor}, ${revision.task_id}, ${revision.object_type}, ${revision.object_id},
        ${stateJson(revision.before)}, ${stateJson(revision.after)}, ${revision.reason})
      RETURNING id`
    const record = row && (await getRecord(row.id))
    if (!record) {
      throw new Error('Revision was not recorded')
    }
    return toRevision(record)
  },
  get: async (id: number) => {
    const record = await getRecord(id)
    return record && toRevision(record)
  },
  /** Newest first. */
  list: async (ref: RevisionObjectRef, limit: number) =>
    (
      await sql<RevisionRecord[]>`${SELECT} WHERE r.object_type = ${ref.object_type} AND r.object_id = ${ref.object_id}
        ORDER BY r.id DESC LIMIT ${limit}`
    ).map(toRevision),
  /** The newest notes on objects of one type, newest first. */
  notes: async (objectType: RevisionObjectType, limit: number) =>
    (
      await sql<RevisionRecord[]>`${SELECT} WHERE r.object_type = ${objectType} AND r.after IS NULL
        ORDER BY r.id DESC LIMIT ${limit}`
    ).map(toRevision),
  unseen: async () => [
    ...(await sql<
      UnseenChange[]
    >`SELECT r.object_type, r.object_id, r.id AS revision_id, r.at, r.task_id FROM revision r
      WHERE r.actor = 'agent'
        AND r.id = (SELECT MAX(x.id) FROM revision x
                    WHERE x.object_type = r.object_type AND x.object_id = r.object_id AND x.after IS NOT NULL)
        AND r.id > COALESCE((SELECT s.revision_id FROM revision_seen s
                             WHERE s.object_type = r.object_type AND s.object_id = r.object_id), 0)
      ORDER BY r.id DESC`),
  ],
  markSeen: async (ref: RevisionObjectRef) => {
    await sql`INSERT INTO revision_seen (object_type, object_id, revision_id)
      SELECT object_type, object_id, MAX(id) FROM revision
      WHERE object_type = ${ref.object_type} AND object_id = ${ref.object_id}
      GROUP BY object_type, object_id
      ON CONFLICT (object_type, object_id) DO UPDATE SET revision_id = excluded.revision_id`
  },
}
