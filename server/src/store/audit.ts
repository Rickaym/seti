import { createHash } from 'node:crypto'
import type {
  AuditChainStatus,
  AuditDetail,
  AuditEvent,
  AuditKind,
  AuditPage,
  AuditQuery,
  AuditSubjectType,
  ModAuditKind,
} from '@seti/shared'
import { sql, transaction, type Db, type Pool } from '../db.js'

/** The hash the first event links to before anything was pruned. */
const GENESIS = '0'.repeat(64)

export interface NewAuditEvent {
  at: string
  actor: AuditEvent['actor']
  kind: AuditKind | ModAuditKind
  subject_type: AuditSubjectType
  subject_id: string | null
  summary: string
  detail: AuditDetail
}

type AuditRecord = Omit<AuditEvent, 'detail'> & { detail: string }

export type ChainRecord = AuditRecord & { prev_hash: string | null; hash: string | null }

export interface Chain {
  anchor_id: number
  anchor_hash: string
  head_id: number
  head_hash: string
}

const UNLINKED: Chain = { anchor_id: 0, anchor_hash: GENESIS, head_id: 0, head_hash: GENESIS }

/** SHA-256 over the stored fields of an event and the hash of the event before it. */
export const eventHash = (r: AuditRecord, prevHash: string) =>
  createHash('sha256')
    .update(JSON.stringify([r.id, r.at, r.actor, r.kind, r.subject_type, r.subject_id, r.summary, r.detail, prevHash]))
    .digest('hex')

const toEvent = (r: AuditRecord): AuditEvent => ({ ...r, detail: JSON.parse(r.detail) as AuditDetail })

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`)

const EVENT_COLUMNS = 'id, at, actor, kind, subject_type, subject_id, summary, detail'

/** Collects the clauses of an event query with numbered parameters. */
class Where {
  readonly clauses: string[] = []
  readonly params: (string | number)[] = []

  add(clause: (...refs: string[]) => string, ...values: (string | number)[]): void {
    const refs = values.map((value) => {
      this.params.push(value)
      return `$${String(this.params.length)}`
    })
    this.clauses.push(clause(...refs))
  }

  get sql(): string {
    return this.clauses.length === 0 ? '' : `WHERE ${this.clauses.join(' AND ')}`
  }
}

/** An area such as `task` matches every `task.*` kind as an index range. */
function addKind(where: Where, kind: string): void {
  if (kind.includes('.')) {
    where.add((ref) => `kind = ${ref}`, kind)
    return
  }
  where.add((from, to) => `kind >= ${from} AND kind < ${to}`, `${kind}.`, `${kind}/`)
}

/** SQLite matched LIKE without regard to ASCII case, so the search uses ILIKE. */
function whereOf(query: AuditQuery): Where {
  const where = new Where()
  if (query.kind !== undefined) {
    addKind(where, query.kind)
  }
  if (query.actor === 'mod') {
    where.add((from, to) => `actor >= ${from} AND actor < ${to}`, 'mod:', 'mod;')
  } else if (query.actor !== undefined) {
    where.add((ref) => `actor = ${ref}`, query.actor)
  }
  if (query.q !== undefined && query.q !== '') {
    const like = `%${escapeLike(query.q)}%`
    where.add((ref) => `(summary ILIKE ${ref} OR kind ILIKE ${ref} OR subject_id ILIKE ${ref})`, like)
  }
  if (query.before !== undefined) {
    where.add((ref) => `id < ${ref}`, query.before)
  }
  return where
}

async function readChain(db: Db): Promise<Chain | undefined> {
  return (await db<Chain[]>`SELECT anchor_id, anchor_hash, head_id, head_hash FROM audit_chain WHERE id = 1`).at(0)
}

/** The chain row, locked until the transaction ends, so writers in every process take turns. */
async function lockChain(tx: Db): Promise<Chain> {
  await tx`INSERT INTO audit_chain (id, anchor_id, anchor_hash, head_id, head_hash)
    VALUES (1, 0, ${GENESIS}, 0, ${GENESIS}) ON CONFLICT DO NOTHING`
  const [row] = await tx<Chain[]>`SELECT anchor_id, anchor_hash, head_id, head_hash FROM audit_chain
    WHERE id = 1 FOR UPDATE`
  if (row === undefined) {
    throw new Error('audit chain row is missing')
  }
  return row
}

async function sealRecord(tx: Db, record: AuditRecord, prevHash: string): Promise<string> {
  const hash = eventHash(record, prevHash)
  await tx`UPDATE audit_event SET prev_hash = ${prevHash}, hash = ${hash} WHERE id = ${record.id}`
  await tx`UPDATE audit_chain SET head_id = ${record.id}, head_hash = ${hash} WHERE id = 1`
  return hash
}

/** Links events written without a hash, by a migration or an older Seti, after the head. */
async function sealPending(): Promise<void> {
  await transaction(async (tx) => {
    const { head_id, head_hash } = await lockChain(tx)
    let prev = head_hash
    const unsealed = await tx<ChainRecord[]>`SELECT * FROM audit_event WHERE hash IS NULL AND id > ${head_id}
      ORDER BY id`
    for (const record of unsealed) {
      prev = await sealRecord(tx, record, prev)
    }
  })
}

async function insertSealed(event: NewAuditEvent): Promise<number> {
  return transaction(async (tx) => {
    const { head_hash } = await lockChain(tx)
    const detail = JSON.stringify(event.detail)
    const [row] = await tx<{ id: number }[]>`INSERT INTO audit_event
        (at, actor, kind, subject_type, subject_id, summary, detail, prev_hash)
      VALUES (${event.at}, ${event.actor}, ${event.kind}, ${event.subject_type}, ${event.subject_id},
        ${event.summary}, ${detail}, ${head_hash})
      RETURNING id`
    if (row === undefined) {
      throw new Error('Audit event was not recorded')
    }
    await sealRecord(tx, { ...event, id: row.id, detail }, head_hash)
    return row.id
  })
}

/** Events recorded by this process join the chain in the order they were recorded. */
let appended: Promise<unknown> = Promise.resolve()

async function append(event: NewAuditEvent): Promise<number> {
  const next = appended.then(async () => insertSealed(event))
  appended = next.catch(() => undefined)
  return next
}

/** Drops the oldest events up to the last one before the cutoff; the chain restarts from it. */
async function pruneBefore(cutoff: string): Promise<number> {
  return transaction(async (tx) => {
    await lockChain(tx)
    const [last] = await tx<{ id: number; hash: string | null }[]>`SELECT id, hash FROM audit_event
      WHERE id = (SELECT MAX(id) FROM audit_event WHERE at < ${cutoff})`
    if (last === undefined) {
      return 0
    }
    const removed = await tx`DELETE FROM audit_event WHERE id <= ${last.id}`
    await tx`UPDATE audit_chain SET anchor_id = ${last.id}, anchor_hash = ${last.hash ?? ''} WHERE id = 1`
    return removed.count
  })
}

const broken = (checked: number, head: Chain, at: number, problem: string): AuditChainStatus => ({
  ok: false,
  checked,
  head_id: head.head_id,
  head_hash: head.head_hash,
  broken_at: at,
  problem,
})

const VERIFY_BATCH = 500

/** The chain row and events as stored, which the checks read the same way from either database. */
interface StoredChain {
  head: Chain | undefined
  /** Every event oldest first, in batches. */
  events: AsyncIterable<readonly ChainRecord[]>
}

/** Checks every link and hash from the anchor up to the recorded head. */
export async function checkChain({ head: stored, events }: StoredChain): Promise<AuditChainStatus> {
  const head = stored ?? UNLINKED
  let prev = { id: head.anchor_id, hash: head.anchor_hash }
  let checked = 0
  for await (const batch of events) {
    for (const record of batch) {
      if (record.prev_hash !== prev.hash) {
        return broken(checked, head, record.id, `Event #${String(record.id)} does not link to the event before it`)
      }
      if (record.hash !== eventHash(record, prev.hash)) {
        return broken(checked, head, record.id, `Event #${String(record.id)} was changed after it was recorded`)
      }
      prev = { id: record.id, hash: record.hash }
      checked += 1
    }
  }
  if (prev.id !== head.head_id || prev.hash !== head.head_hash) {
    return broken(
      checked,
      head,
      head.head_id,
      `The newest events do not match the recorded head #${String(head.head_id)}`,
    )
  }
  return { ok: true, checked, head_id: head.head_id, head_hash: head.head_hash, broken_at: null, problem: null }
}

/** Walks one snapshot of the events oldest first and checks every link and hash up to the head. */
export async function verifyAuditChain(database: Pool): Promise<AuditChainStatus> {
  return database.begin('ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx): Promise<AuditChainStatus> =>
    checkChain({
      head: await readChain(tx),
      events: tx<ChainRecord[]>`SELECT * FROM audit_event ORDER BY id`.cursor(VERIFY_BATCH),
    }),
  )
}

export const auditEvents = {
  insert: append,
  /** Newest first; fetches one extra row to know whether an older page exists. */
  page: async (query: AuditQuery): Promise<AuditPage> => {
    const where = whereOf(query)
    where.params.push(query.limit + 1)
    const rows = await sql.unsafe<AuditRecord[]>(
      `SELECT ${EVENT_COLUMNS} FROM audit_event ${where.sql} ORDER BY id DESC LIMIT $${String(where.params.length)}`,
      where.params,
    )
    const events = rows.slice(0, query.limit).map(toEvent)
    const last = events.at(-1)
    return { events, next_before: rows.length > query.limit && last ? last.id : null }
  },
  latest: async (kind: AuditKind | ModAuditKind): Promise<AuditEvent | undefined> => {
    const [record] = await sql<AuditRecord[]>`SELECT id, at, actor, kind, subject_type, subject_id, summary, detail
      FROM audit_event WHERE kind = ${kind} ORDER BY id DESC LIMIT 1`
    return record && toEvent(record)
  },
  prune: pruneBefore,
  verify: async () => verifyAuditChain(sql),
  sealPending,
  /** Resolves once every event recorded so far in this process is stored. */
  settled: async () => {
    await appended
  },
}
