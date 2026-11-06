import { setTimeout as sleep } from 'node:timers/promises'
import type { SearchHit, SearchMode, SearchResult } from '@seti/shared'
import { messages, sql } from '../db.js'
import { hiddenIds, transcriptReader } from '../direct-privacy.js'
import { visibleTo, type TeamReader } from './team.js'

/** Characters of context kept before the match in a snippet, and the snippet's whole length. */
const SNIPPET_LEAD = 60
const SNIPPET_LENGTH = 200
const BACKFILL_BATCH = 2000
const BACKFILL_PAUSE_MS = 25

export interface ChatSearch {
  q: string
  mode: SearchMode
  before?: number | undefined
  limit: number
  /** Tool calls and their output, shell runs and Seti's notes too, not only the conversation. */
  tools?: boolean | undefined
}

/** A LIKE pattern matching `q` anywhere, with the wildcards and the escape in `q` taken literally. */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/gu, '\\$&')}%`

/** The first query word, where a words-mode snippet centres. */
const firstWord = (q: string) => /[\p{L}\p{N}_]+/u.exec(q)?.[0] ?? q

const hasWord = (q: string) => /[\p{L}\p{N}]/u.test(q)

/** Where a chat's searchable text lives; the indexes lead with the scope column when there is one. */
interface SearchTable {
  table: 'message_search' | 'team_message'
  id: 'message_id' | 'id'
  kind: 'kind' | 'author_kind'
  /** talk holds the conversation alone, and is null on rows with none. */
  text: 'body' | 'text' | 'talk'
  scope: { column: 'task_id'; value: string } | null
  /** Group chat messages this reader may see; the user sees them all. */
  reader?: TeamReader
}

/** The matching rows, newest first, one more than `limit` to tell whether more exist. */
// eslint-disable-next-line @typescript-eslint/promise-function-async -- unrun, so EXPLAIN can wrap it
function searchQuery(target: SearchTable, { q, mode, before, limit }: ChatSearch) {
  const id = sql(target.id)
  const text = sql(target.text)
  const match =
    mode === 'text'
      ? sql`${text} ILIKE ${containsPattern(q)}`
      : sql`to_tsvector('simple'::regconfig, ${text}) @@ websearch_to_tsquery('simple'::regconfig, ${q})`
  const scope = target.scope === null ? sql`` : sql`${sql(target.scope.column)} = ${target.scope.value} AND`
  const talk = target.text === 'talk' ? sql`talk IS NOT NULL AND` : sql``
  const seen = target.reader === undefined ? sql`` : sql`${visibleTo(target.reader)} AND`
  const needle = mode === 'text' ? q : firstWord(q)
  return sql<SearchHit[]>`SELECT ${id} AS id, ${sql(target.kind)} AS kind, created_at,
      (SELECT CASE WHEN w.start > 1 THEN '...' ELSE '' END || substr(${text}, w.start, ${SNIPPET_LENGTH})
        || CASE WHEN w.start + ${SNIPPET_LENGTH} <= length(${text}) THEN '...' ELSE '' END
      FROM (SELECT greatest(strpos(lower(${text}), lower(${needle})) - ${SNIPPET_LEAD}, 1) AS start) AS w) AS snippet
    FROM ${sql(target.table)}
    WHERE ${scope} ${talk} ${seen} ${id} < ${before ?? Number.MAX_SAFE_INTEGER} AND ${match}
    ORDER BY ${id} DESC LIMIT ${limit + 1}`
}

async function runSearch(target: SearchTable, search: ChatSearch): Promise<SearchResult> {
  const rows = search.mode === 'words' && !hasWord(search.q) ? [] : await searchQuery(target, search)
  const hits = rows.slice(0, search.limit)
  return { hits, has_more: rows.length > search.limit, total: hits.length }
}

const taskTable = (taskId: string, tools = false): SearchTable => ({
  table: 'message_search',
  id: 'message_id',
  kind: 'kind',
  text: tools ? 'body' : 'talk',
  scope: { column: 'task_id', value: taskId },
})

const teamTable = (reader: TeamReader): SearchTable => ({
  table: 'team_message',
  id: 'id',
  kind: 'author_kind',
  text: 'text',
  scope: null,
  reader,
})

/** A direct message the reader is not party to never matches, so a search cannot probe its words. */
async function withoutHidden(taskId: string, result: SearchResult): Promise<SearchResult> {
  if (transcriptReader().kind === 'user' || result.hits.length === 0) {
    return result
  }
  const rows = await messages.byIds(
    taskId,
    result.hits.map((hit) => hit.id),
  )
  const hidden = await hiddenIds(taskId, rows)
  const hits = result.hits.filter((hit) => !hidden.has(hit.id))
  return { ...result, hits, total: hits.length }
}

export const messageSearch = {
  search: async (taskId: string, search: ChatSearch) =>
    withoutHidden(taskId, await runSearch(taskTable(taskId, search.tools), search)),
  /** The plan Postgres picks for a search, so tests can pin that it scans an index. */
  plan: async (taskId: string, search: ChatSearch): Promise<string> => {
    const rows = await sql<{ 'QUERY PLAN': string }[]>`EXPLAIN ${searchQuery(taskTable(taskId, search.tools), search)}`
    return rows.map((row) => row['QUERY PLAN']).join('\n')
  },
}

export const teamSearch = {
  /** Messages the reader may see that match, newest first. */
  search: async (reader: TeamReader, search: ChatSearch) => runSearch(teamTable(reader), search),
}

/** Indexes one batch of rows written before the search migration, newest first; false once done. */
async function backfillBatch(batch: number): Promise<boolean> {
  return sql.begin(async (tx) => {
    const [state] = await tx<{ below: number }[]>`SELECT below FROM message_search_backfill FOR UPDATE`
    if (state === undefined) {
      return false
    }
    const [range] = await tx<{ low: number | null }[]>`SELECT MIN(id) AS low FROM (
      SELECT id FROM task_message WHERE id < ${state.below} ORDER BY id DESC LIMIT ${batch}) AS ids`
    const low = range?.low ?? null
    if (low === null) {
      await tx`DELETE FROM message_search_backfill`
      return false
    }
    await tx`INSERT INTO message_search (message_id, task_id, kind, created_at, body, talk)
      SELECT id, task_id, kind, created_at, body, message_search_talk(kind, payload) FROM (
        SELECT id, task_id, kind, created_at, payload, message_search_text(kind, payload) AS body
        FROM task_message WHERE id >= ${low} AND id < ${state.below}) AS rows
      WHERE body IS NOT NULL
      ON CONFLICT (message_id) DO NOTHING`
    await tx`UPDATE message_search_backfill SET below = ${low}`
    return true
  })
}

/** Indexes rows older than the search migration in short transactions; resumes after a restart. */
export async function backfillMessageSearch(batch = BACKFILL_BATCH, pauseMs = BACKFILL_PAUSE_MS): Promise<number> {
  let batches = 0
  while (await backfillBatch(batch)) {
    batches += 1
    await sleep(pauseMs)
  }
  return batches
}
