import type { EaDocKind, MessageRow } from '@seti/shared'
import { sql, toMessage, transaction, type MessageRecord } from '../db.js'
import { EMBEDDING_DIMENSIONS } from '../embeddings.js'

/** A searchable piece of text; `key` names where it came from, so indexing twice changes nothing. */
export interface IndexDoc {
  key: string
  /** Texts are unique per scope, so a turn's result that repeats its last words is kept once. */
  scope: string
  kind: EaDocKind
  task_id: string | null
  message_id: number | null
  pr_url: string | null
  repo: string | null
  title: string
  body: string
  hash: string
  at: string
}

/** Null matches everything; a repo matches by its slug or by its name alone. */
export interface SearchFilter {
  task_id: string | null
  repo: string | null
}

export interface RankedDoc {
  id: number
  score: number
  at: string
  /** From an archived task. */
  archived: boolean
}

export interface DocDetail {
  id: number
  kind: EaDocKind
  task_id: string | null
  task_title: string | null
  pr_url: string | null
  title: string
  repo: string | null
  at: string
  snippet: string
}

const vectorLiteral = (vector: readonly number[]) => `[${vector.join(',')}]`

const RANK_POOL = 200
const HEADLINE = 'MaxWords=70, MinWords=30, ShortWord=2, MaxFragments=2, FragmentDelimiter=" ... "'

export const eaIndex = {
  /** Stores new documents; ones whose key or text the scope already holds are skipped. */
  add: async (docs: readonly IndexDoc[]): Promise<number> => {
    let added = 0
    for (const doc of docs) {
      const result = await sql`INSERT INTO ea_doc (key, scope, kind, task_id, message_id, pr_url, repo, title, body,
          hash, at)
        VALUES (${doc.key}, ${doc.scope}, ${doc.kind}, ${doc.task_id}, ${doc.message_id}, ${doc.pr_url},
          ${doc.repo}, ${doc.title}, ${doc.body}, ${doc.hash}, ${doc.at})
        ON CONFLICT DO NOTHING`
      added += result.count
    }
    return added
  },
  /** Drops a scope's documents of a kind whose text is not in `keep`, as when a PR body changes. */
  prune: async (scope: string, kind: EaDocKind, keep: readonly string[]) => {
    await sql`DELETE FROM ea_doc WHERE scope = ${scope} AND kind = ${kind} AND NOT (hash = ANY(${keep}::text[]))`
  },
  cursor: async (taskId: string): Promise<number> =>
    (await sql<{ message_id: number }[]>`SELECT message_id FROM ea_index_cursor WHERE task_id = ${taskId}`).at(0)
      ?.message_id ?? 0,
  setCursor: async (taskId: string, messageId: number) => {
    await sql`INSERT INTO ea_index_cursor (task_id, message_id) VALUES (${taskId}, ${messageId})
      ON CONFLICT (task_id) DO UPDATE SET message_id = excluded.message_id`
  },
  messagesAfter: async (taskId: string, after: number, limit: number): Promise<MessageRow[]> =>
    (
      await sql<MessageRecord[]>`SELECT * FROM task_message WHERE task_id = ${taskId} AND id > ${after}
        ORDER BY id LIMIT ${limit}`
    ).map(toMessage),
  /** Tasks with messages the index has not read yet, most recently changed first. */
  behind: async (): Promise<string[]> =>
    (
      await sql<{ id: string }[]>`SELECT t.id FROM task t LEFT JOIN ea_index_cursor c ON c.task_id = t.id
        WHERE EXISTS (SELECT 1 FROM task_message m WHERE m.task_id = t.id AND m.id > COALESCE(c.message_id, 0))
        ORDER BY t.updated_at DESC`
    ).map((row) => row.id),
  unembedded: async (limit: number) =>
    sql<{ id: number; title: string; body: string }[]>`SELECT id, title, body FROM ea_doc
      WHERE embedding IS NULL ORDER BY id DESC LIMIT ${limit}`,
  setEmbeddings: async (rows: readonly { id: number; embedding: readonly number[] }[]) => {
    await transaction(async (tx) => {
      for (const row of rows) {
        const array = `{${row.embedding.join(',')}}`
        await tx`UPDATE ea_doc SET embedding = ${array}::real[] WHERE id = ${row.id}`
      }
    })
  },
  counts: async () =>
    (
      await sql<{ documents: number; embedded: number }[]>`SELECT COUNT(*)::int AS documents,
        COUNT(embedding)::int AS embedded FROM ea_doc`
    ).at(0) ?? { documents: 0, embedded: 0 },
  /** Turns on vector search where pgvector is installed or this role may create it; else false. */
  enableVector: async (): Promise<boolean> => {
    const installed = async () => (await sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`).length > 0
    if (!(await installed())) {
      try {
        await sql`CREATE EXTENSION IF NOT EXISTS vector`
      } catch {
        return false
      }
    }
    await sql.unsafe(`CREATE INDEX IF NOT EXISTS ea_doc_embedding ON ea_doc
      USING hnsw ((embedding::vector(${String(EMBEDDING_DIMENSIONS)})) vector_cosine_ops)`)
    return true
  },
  /** Any-word matches; the score is the share of the words a document holds, rank breaks ties. */
  textSearch: async (words: readonly string[], filter: SearchFilter, limit: number): Promise<RankedDoc[]> => {
    if (words.length === 0) {
      return []
    }
    const { task_id: task, repo } = filter
    const byName = `%/${repo ?? ''}`
    return sql<RankedDoc[]>`WITH q AS (
        SELECT to_tsquery('english', ${words.join(' | ')}) AS query,
          tsvector_to_array(to_tsvector('english', ${words.join(' ')})) AS lexemes
      ), ranked AS (
        SELECT d.id, d.at, d.archived, d.tsv, ts_rank('{1,1,1,1}', d.tsv, q.query, 32) AS rank FROM ea_doc d, q
        WHERE d.tsv @@ q.query AND (${task}::text IS NULL OR d.task_id = ${task})
          AND (${repo}::text IS NULL OR d.repo = ${repo} OR d.repo LIKE ${byName})
        ORDER BY rank DESC LIMIT ${RANK_POOL}
      )
      SELECT r.id, r.at, r.archived = 1 AS archived, (SELECT COUNT(*) FROM unnest(q.lexemes) AS l WHERE l = ANY(tsvector_to_array(r.tsv)))::float
          / GREATEST(cardinality(q.lexemes), 1) AS score
      FROM ranked r, q ORDER BY score DESC, r.rank DESC, r.id DESC LIMIT ${limit}`
  },
  /** Documents nearest to `vector` by cosine; the score is their similarity. Needs pgvector. */
  vectorSearch: async (vector: readonly number[], filter: SearchFilter, limit: number): Promise<RankedDoc[]> => {
    const type = sql.unsafe(`vector(${String(EMBEDDING_DIMENSIONS)})`)
    const target = vectorLiteral(vector)
    const { task_id: task, repo } = filter
    const byName = `%/${repo ?? ''}`
    return sql<RankedDoc[]>`SELECT id, 1 - (embedding::${type} <=> ${target}::${type}) AS score, at,
        archived = 1 AS archived
      FROM ea_doc WHERE embedding IS NOT NULL AND (${task}::text IS NULL OR task_id = ${task})
        AND (${repo}::text IS NULL OR repo = ${repo} OR repo LIKE ${byName})
      ORDER BY embedding::${type} <=> ${target}::${type} LIMIT ${limit}`
  },
  /** The documents with their task's current title and a snippet around the words, in id order. */
  details: async (ids: readonly number[], words: readonly string[]): Promise<DocDetail[]> => {
    if (ids.length === 0) {
      return []
    }
    const query = words.length === 0 ? sql`NULL::tsquery` : sql`to_tsquery('english', ${words.join(' | ')})`
    return sql<DocDetail[]>`SELECT d.id, d.kind, d.task_id, t.title AS task_title, d.pr_url, d.title, d.repo, d.at,
        CASE WHEN ${query} IS NULL OR NOT (d.tsv @@ ${query}) THEN left(d.body, 500)
          ELSE ts_headline('english', d.body, ${query}, ${HEADLINE}) END AS snippet
      FROM ea_doc d LEFT JOIN task t ON t.id = d.task_id WHERE d.id = ANY(${ids}::bigint[]) ORDER BY d.id`
  },
}
