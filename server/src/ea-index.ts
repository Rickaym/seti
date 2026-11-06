import type { EaIndexStatus, EaSearchHit, EaSearchResult, eaSearchQuery } from '@seti/shared'
import type { z } from 'zod'
import { tasks } from './db.js'
import { prDocs, subagentNames, taskDocs } from './ea-index-docs.js'
import { openAiEmbedder, queryEmbedder, readEmbeddingKey, type Embedder } from './embeddings.js'
import type { OpenPr } from './github.js'
import { onOpenPrsFetched } from './prs.js'
import { onTurnEnd } from './runner.js'
import { redactCredentials } from './scrub.js'
import { eaIndex, type RankedDoc, type SearchFilter } from './store/ea-index.js'
import { subtaskBriefs } from './subtask-cache.js'

const PAGE_ROWS = 200
const EMBED_BATCH = 64
const CANDIDATES = 40
/** Reciprocal rank fusion: each list adds 1 / (RRF_K + rank), so neither list's scale matters. */
const RRF_K = 60
const RECENCY_BOOST = 0.5
const RECENCY_HALF_LIFE_DAYS = 7
/** Archived tasks' documents stay findable but count for half. */
const ARCHIVED_WEIGHT = 0.5
const DAY_MS = 86_400_000
const MAX_QUERY_WORDS = 16
const SNIPPET_CHARS = 500

type SearchInput = z.output<typeof eaSearchQuery>

/** Indexes the task's messages since the last pass; the number of documents added. */
export async function indexTask(taskId: string): Promise<number> {
  const task = await tasks.get(taskId)
  if (!task) {
    return 0
  }
  let cursor = await eaIndex.cursor(taskId)
  let added = 0
  let subagents: Map<string, string> | null = null
  for (;;) {
    const rows = await eaIndex.messagesAfter(taskId, cursor, PAGE_ROWS)
    const last = rows.at(-1)
    if (last === undefined) {
      return added
    }
    subagents ??= subagentNames(await subtaskBriefs(taskId, null))
    added += await eaIndex.add(taskDocs(task, rows, subagents))
    cursor = last.id
    await eaIndex.setCursor(taskId, cursor)
  }
}

/** Indexes the descriptions of open PRs, replacing those that changed. */
export async function indexPrs(prs: readonly OpenPr[]): Promise<number> {
  let added = 0
  for (const pr of prs) {
    const docs = prDocs(pr)
    await eaIndex.prune(
      `pr:${pr.url}`,
      'pr_body',
      docs.map((doc) => doc.hash),
    )
    added += await eaIndex.add(docs)
  }
  return added
}

const embeddingInput = (doc: { title: string; body: string }) =>
  doc.title === '' ? doc.body : `${doc.title}\n\n${doc.body}`

/** Embeds documents that have no embedding yet, newest first; the number embedded. */
export async function embedPending(embedder: Embedder, max = Number.MAX_SAFE_INTEGER): Promise<number> {
  let done = 0
  while (done < max) {
    const batch = await eaIndex.unembedded(Math.min(EMBED_BATCH, max - done))
    if (batch.length === 0) {
      return done
    }
    const vectors = await embedder.embed(batch.map(embeddingInput))
    await eaIndex.setEmbeddings(batch.map((doc, index) => ({ id: doc.id, embedding: vectors[index] ?? [] })))
    done += batch.length
  }
  return done
}

/** Lowercase words of a query, deduplicated, for an any-word full-text match. */
export function queryWords(query: string): string[] {
  const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return [...new Set(words.filter((word) => word.length > 1))].slice(0, MAX_QUERY_WORDS)
}

export interface Fused {
  id: number
  score: number
  text: number
  archived: boolean
}

/** Ranks by reciprocal rank fusion of both lists, recent documents up, archived ones down. */
export function fuse(textHits: readonly RankedDoc[], vectorHits: readonly RankedDoc[], now: number): Fused[] {
  const scores = new Map<number, { rrf: number; at: string; text: number; archived: boolean }>()
  const add = (hits: readonly RankedDoc[], isText: boolean) => {
    hits.forEach((hit, rank) => {
      const entry = scores.get(hit.id) ?? { rrf: 0, at: hit.at, text: 0, archived: hit.archived }
      entry.rrf += 1 / (RRF_K + rank + 1)
      if (isText) {
        entry.text = hit.score
      }
      scores.set(hit.id, entry)
    })
  }
  add(textHits, true)
  add(vectorHits, false)
  const ranked = [...scores.entries()].map(([id, entry]) => {
    const ageDays = Math.max(0, now - Date.parse(entry.at)) / DAY_MS
    const recency = 1 + RECENCY_BOOST * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS)
    const weight = entry.archived ? ARCHIVED_WEIGHT : 1
    return { id, score: entry.rrf * recency * weight, text: entry.text, archived: entry.archived }
  })
  return ranked.toSorted((a, b) => (a.score === b.score ? b.id - a.id : b.score - a.score))
}

const clipSnippet = (text: string) => {
  const flat = text
    .replace(/<\/?b>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 3).trimEnd()}...` : flat
}

const SAME_START_CHARS = 80

/** Drops hits that open like a better one, as a turn's result repeating the agent's last words. */
function distinct(hits: readonly EaSearchHit[]): EaSearchHit[] {
  const seen = new Set<string>()
  return hits.filter((hit) => {
    const start = `${hit.task_id ?? hit.pr_url ?? ''}:${hit.snippet.slice(0, SAME_START_CHARS).toLowerCase()}`
    const fresh = !seen.has(start)
    seen.add(start)
    return fresh
  })
}

let vectorReady = false
let embedder: Embedder | null = null
let embedQuery: ((query: string) => Promise<number[]>) | null = null

/** Sets what search and indexing use; tests pass a fake embedder. */
export function configureIndex(options: { vector: boolean; embedder: Embedder | null }): void {
  vectorReady = options.vector
  embedder = options.embedder
  embedQuery = options.embedder === null ? null : queryEmbedder(options.embedder)
}

export async function indexStatus(): Promise<EaIndexStatus> {
  return { ...(await eaIndex.counts()), vector: vectorReady, embeddings: embedder !== null }
}

async function nearest(query: string, filter: SearchFilter): Promise<RankedDoc[] | null> {
  if (!vectorReady || embedQuery === null) {
    return null
  }
  try {
    return await eaIndex.vectorSearch(await embedQuery(query), filter, CANDIDATES)
  } catch (e) {
    process.stderr.write(`ea search: ${e instanceof Error ? e.message : String(e)}; searching text only\n`)
    return null
  }
}

/** Full-text and, when available, vector search, with recent documents first among equals. */
export async function searchIndex(input: SearchInput, now = Date.now()): Promise<EaSearchResult> {
  const words = queryWords(input.q)
  const filter = { task_id: input.task ?? null, repo: input.repo ?? null }
  const [text, vector] = await Promise.all([
    eaIndex.textSearch(words, filter, CANDIDATES),
    input.mode === 'hybrid' ? nearest(input.q, filter) : Promise.resolve(null),
  ])
  const minMatch = input.min_match ?? 0
  const ranked = fuse(text, vector ?? [], now)
    .filter((hit) => hit.text >= minMatch)
    .slice(0, input.limit * 2)
  const best = ranked[0]?.score ?? 1
  const details = new Map(
    (
      await eaIndex.details(
        ranked.map((hit) => hit.id),
        words,
      )
    ).map((doc) => [doc.id, doc]),
  )
  const hits = ranked.flatMap((hit): EaSearchHit[] => {
    const doc = details.get(hit.id)
    if (doc === undefined) {
      return []
    }
    return [
      {
        kind: doc.kind,
        task_id: doc.task_id,
        task_title: doc.task_title,
        pr_url: doc.pr_url,
        pr_title: doc.kind === 'pr_body' ? doc.title : null,
        repo: doc.repo,
        at: doc.at,
        snippet: clipSnippet(redactCredentials(doc.snippet)),
        score: Math.round((hit.score / best) * 1000) / 1000,
        archived: hit.archived,
      },
    ]
  })
  return { mode: vector === null ? 'text' : 'hybrid', hits: distinct(hits).slice(0, input.limit) }
}

/** The embedder the server uses, when the EA's OpenAI key is there. */
function defaultEmbedder(): Embedder | null {
  const key = readEmbeddingKey()
  return key === null ? null : openAiEmbedder(key)
}

const PASS_MS = 15_000
const TURN_END_DELAY_MS = 1_000
let passing: Promise<void> | null = null
let soon: NodeJS.Timeout | null = null
let lastError = ''

function logError(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e)
  if (message !== lastError) {
    lastError = message
    process.stderr.write(`ea index: ${message}\n`)
  }
}

/** Every task with messages the index has not read, then every document without an embedding. */
export async function backfillIndex(onProgress: (done: number, total: number) => void = () => undefined) {
  const behind = await eaIndex.behind()
  let added = 0
  for (const [index, taskId] of behind.entries()) {
    added += await indexTask(taskId)
    onProgress(index + 1, behind.length)
  }
  const embedded = embedder === null ? 0 : await embedPending(embedder)
  return { tasks: behind.length, added, embedded }
}

/** One catch-up at a time; a pass asked for meanwhile is covered by the next timer. */
async function runPass(): Promise<void> {
  passing ??= backfillIndex()
    .then(() => undefined, logError)
    .finally(() => {
      passing = null
    })
  await passing
}

function passSoon(): void {
  soon ??= setTimeout(() => {
    soon = null
    void runPass()
  }, TURN_END_DELAY_MS)
}

/** Sets search up as the database and key allow; the CLI and the server both start here. */
export async function configureDefaultIndex(): Promise<EaIndexStatus> {
  configureIndex({ vector: await eaIndex.enableVector().catch(() => false), embedder: defaultEmbedder() })
  return indexStatus()
}

/** Catches the index up now and every few seconds, soon after each turn, and as PR lists arrive. */
export async function startEaIndex(): Promise<void> {
  await configureDefaultIndex()
  onTurnEnd(passSoon)
  onOpenPrsFetched((prs) => {
    void indexPrs(prs).catch(logError)
  })
  setInterval(() => void runPass(), PASS_MS).unref()
  void runPass()
}
