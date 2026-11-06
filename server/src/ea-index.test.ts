import { createHash } from 'node:crypto'
import type { EaIndexStatus, EaSearchResult, MessageBody, PrInput } from '@seti/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, sql, tasks } from './db.js'
import { chunkText, taskDocs } from './ea-index-docs.js'
import {
  backfillIndex,
  configureIndex,
  embedPending,
  fuse,
  indexPrs,
  indexTask,
  queryWords,
  searchIndex,
} from './ea-index.js'
import { EMBEDDING_DIMENSIONS, type Embedder } from './embeddings.js'
import type { OpenPr } from './github.js'
import { eaIndex } from './store/ea-index.js'
import { agentCall, assistant, completedResult } from './subtask-fixtures.js'
import { USER_AUTH } from './test-auth.js'

/** Words that share one dimension, so the fake embedder finds texts with no word in common. */
const TOPICS: Record<string, string> = { redact: 'privacy', mask: 'privacy', personal: 'privacy', pii: 'privacy' }

/** Bag-of-words vectors: one dimension per word or topic, normalised like OpenAI's. */
const fakeEmbedder = (calls: string[][] = []): Embedder => ({
  embed: async (texts) => {
    calls.push([...texts])
    return Promise.resolve(
      texts.map((text) => {
        const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
        for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
          const topic = Object.keys(TOPICS).find((stem) => word.startsWith(stem))
          const key = topic === undefined ? word : (TOPICS[topic] ?? word)
          const slot = createHash('sha256').update(key).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS
          vector[slot] = (vector[slot] ?? 0) + 1
        }
        const norm = Math.hypot(...vector)
        return vector.map((value) => (norm === 0 ? 0 : value / norm))
      }),
    )
  },
})

const vectorAvailable = await eaIndex.enableVector()
const app = createApp()
const LOCAL = { host: '127.0.0.1:3006', ...USER_AUTH }
const PR = 'https://github.com/acme/web/pull/7'
let count = 0

async function newTask(title: string): Promise<string> {
  count += 1
  const id = `idx-${String(count)}`
  await tasks.insert({ id, title, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  return id
}

const text = (value: string): MessageBody => assistant([{ type: 'text', text: value }])
const prompt = (value: string, extra: Record<string, unknown> = {}): MessageBody => ({
  kind: 'prompt',
  payload: { text: value, ...extra },
})
const result = (value: string): MessageBody => {
  const payload: Record<string, unknown> = { type: 'result', subtype: 'success', is_error: false, result: value }
  return { kind: 'sdk', payload } as MessageBody
}
const update = (input: Partial<PrInput>): MessageBody => ({
  kind: 'input',
  payload: {
    source: 'pr',
    kind: 'review',
    subject: 'acme/web#7',
    title: 'octo requested changes on acme/web#7',
    body: 'Please keep the email domain when you redact addresses.',
    url: `${PR}#pullrequestreview-1`,
    ...input,
  },
})

const DECISION =
  'We decided to redact phone numbers and email addresses with one regex pass before transcripts are stored, ' +
  'keeping the domain of each email so support can still route tickets.'

async function search(query: string) {
  const res = await app.request(`/api/ea/search?${new URLSearchParams(query).toString()}`, { headers: LOCAL })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: EaSearchResult }).data
}

beforeEach(async () => {
  await sql`DELETE FROM task`
  await sql`DELETE FROM ea_doc`
  configureIndex({ vector: false, embedder: null })
})

describe('chunkText', () => {
  it('keeps short text whole and splits long text at paragraphs and sentences', () => {
    expect(chunkText('One paragraph.')).toEqual(['One paragraph.'])
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${String(i)} says something useful.`).join(' ')
    const chunks = chunkText(`${long}\n\nA closing paragraph.`, 400)
    expect(chunks.length).toBeGreaterThan(3)
    expect(chunks.every((chunk) => chunk.length <= 400)).toBe(true)
    expect(chunks.at(-1)).toContain('A closing paragraph.')
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('Sentence number 39 says something useful.')
  })
})

describe('taskDocs', () => {
  it('keeps what the user and agent wrote, reports and PR updates, and skips noise', () => {
    const task = { id: 't', title: 'PII redaction', repo_slug: 'acme/web' }
    const rows = [
      prompt('Please redact personal data from stored transcripts.'),
      prompt('/compact'),
      prompt('', { auto: true, inputs: 1 }),
      text('Let me check.'),
      text(DECISION),
      agentCall('a1', 'survey redaction libraries'),
      completedResult(
        'a1',
        'agent-1',
        'Three libraries exist; none handles our transcript format, so a regex pass it is.',
      ),
      update({}),
      update({ kind: 'ci_passed', title: 'CI passed on acme/web#7', body: 'Every check passed.' }),
    ].map((body, i) => ({ ...body, id: i + 1, task_id: 't', outward: [], created_at: '2026-09-28T10:00:00Z' }))
    const docs = taskDocs(task, rows, new Map([['a1', '"survey redaction libraries" (general-purpose)']]))
    expect(docs.map((doc) => doc.kind)).toEqual(['prompt', 'agent', 'subagent', 'pr_update'])
    expect(docs[2]?.body).toContain('Subagent report, "survey redaction libraries" (general-purpose)')
    expect(docs[2]?.body).not.toContain('agentId')
    expect(docs[3]).toMatchObject({ pr_url: PR, repo: 'acme/web', title: 'PII redaction' })
  })
})

describe('indexing', () => {
  it('reads only new messages, once, and keeps a result that repeats the last words once', async () => {
    const id = await newTask('PII redaction')
    await messages.insert(id, prompt('Please redact personal data from stored transcripts.'), [])
    await messages.insert(id, text(DECISION), [])
    await messages.insert(id, result(DECISION), [])
    expect(await indexTask(id)).toBe(2)
    expect(await indexTask(id)).toBe(0)
    const last = await messages.insert(id, text('The regex now also covers international phone formats like +44.'), [])
    expect(await indexTask(id)).toBe(1)
    expect(await eaIndex.cursor(id)).toBe(last.id)
  })

  it('backfills every task behind and embeds the new documents', async () => {
    const calls: string[][] = []
    configureIndex({ vector: false, embedder: fakeEmbedder(calls) })
    const a = await newTask('PII redaction')
    const b = await newTask('Voicemail detection')
    await messages.insert(a, text(DECISION), [])
    await messages.insert(b, text('Voicemail detection now waits for the beep before it hangs up the call.'), [])
    const done = await backfillIndex()
    expect(done).toEqual({ tasks: 2, added: 2, embedded: 2 })
    expect(calls.flat().some((input) => input.startsWith('PII redaction\n\nWe decided'))).toBe(true)
    expect(await eaIndex.counts()).toEqual({ documents: 2, embedded: 2 })
    expect(await backfillIndex()).toEqual({ tasks: 0, added: 0, embedded: 0 })
    expect(await embedPending(fakeEmbedder())).toBe(0)
  })

  it('replaces a PR description that changed', async () => {
    const pr = { url: PR, repo_slug: 'acme/web', title: 'Redact PII', updated_at: '2026-09-28T10:00:00Z' }
    await indexPrs([{ ...pr, body: 'First draft of the redaction plan.' } as OpenPr])
    await indexPrs([{ ...pr, body: 'Final redaction plan with the email domain kept.' } as OpenPr])
    const bodies = await sql<{ body: string }[]>`SELECT body FROM ea_doc WHERE pr_url = ${PR}`
    expect(bodies.map((row) => row.body)).toEqual(['Final redaction plan with the email domain kept.'])
  })
})

describe('search', () => {
  async function seed() {
    const pii = await newTask('PII redaction')
    const voice = await newTask('Voicemail detection')
    await messages.insert(pii, text(DECISION), [])
    await messages.insert(pii, update({}), [])
    await messages.insert(
      voice,
      text('Voicemail detection waits for the beep, then leaves the message and hangs up.'),
      [],
    )
    await indexTask(pii)
    await indexTask(voice)
    return { pii, voice }
  }

  it('finds documents by any of the words, with the task and a snippet around them', async () => {
    const { pii } = await seed()
    const found = await search('q=what did the team decide about email redaction&mode=text')
    expect(found.mode).toBe('text')
    expect(found.hits[0]).toMatchObject({ kind: 'agent', task_id: pii, task_title: 'PII redaction', score: 1 })
    expect(found.hits[0]?.snippet).toContain('redact phone numbers')
    expect(found.hits.map((hit) => hit.kind)).toContain('pr_update')
    expect(found.hits.find((hit) => hit.kind === 'pr_update')?.pr_url).toBe(PR)
  })

  it('keeps to one task when asked, and drops weak matches under a minimum rank', async () => {
    const { voice } = await seed()
    const scoped = await search(`q=decide beep redaction&task=${voice}`)
    expect(scoped.hits.map((hit) => hit.task_id)).toEqual([voice])
    const strict = await searchIndex({ q: 'beep redaction invoice', limit: 5, mode: 'text', min_match: 0.5 })
    expect(strict.hits).toEqual([])
    const loose = await searchIndex({ q: 'beep redaction invoice', limit: 5, mode: 'text', min_match: 0.3 })
    expect(loose.hits.length).toBeGreaterThan(1)
  })

  it('ranks the newer of two equal matches first', async () => {
    const id = await newTask('Deploys')
    const older = await messages.insert(
      id,
      text('The staging deploy failed because the migration timed out again.'),
      [],
    )
    await sql`UPDATE task_message SET created_at = '2026-01-01T00:00:00Z' WHERE id = ${older.id}`
    await messages.insert(id, text('The production deploy failed because the migration timed out again.'), [])
    await indexTask(id)
    const found = await searchIndex({ q: 'deploy migration timed out', limit: 5, mode: 'text' })
    expect(found.hits[0]?.snippet).toContain('production')
  })

  it('falls back to full text when vector search is unavailable', async () => {
    configureIndex({ vector: false, embedder: fakeEmbedder() })
    await seed()
    await embedPending(fakeEmbedder())
    const found = await search('q=redaction&mode=hybrid')
    expect(found.mode).toBe('text')
    expect(found.hits.length).toBeGreaterThan(0)
  })

  it.runIf(vectorAvailable)('adds documents that share meaning but no words when vectors are on', async () => {
    const embedder = fakeEmbedder()
    configureIndex({ vector: true, embedder })
    const { pii } = await seed()
    await embedPending(embedder)
    expect(await searchIndex({ q: 'personal data', limit: 5, mode: 'text' })).toEqual({ mode: 'text', hits: [] })
    const found = await search('q=personal data')
    expect(found.mode).toBe('hybrid')
    expect(found.hits[0]?.task_id).toBe(pii)
  })

  it('reports the index', async () => {
    configureIndex({ vector: false, embedder: fakeEmbedder() })
    await seed()
    const res = await app.request('/api/ea/index', { headers: LOCAL })
    const status = ((await res.json()) as { data: EaIndexStatus }).data
    expect(status).toEqual({ documents: 3, embedded: 0, vector: false, embeddings: true })
  })
})

describe('fuse', () => {
  it('rewards documents both lists found and recent ones among equals', () => {
    const now = Date.parse('2026-09-28T12:00:00Z')
    const fresh = '2026-09-28T11:00:00Z'
    const old = '2026-06-01T00:00:00Z'
    const ranked = fuse(
      [
        { id: 1, score: 0.5, at: old, archived: false },
        { id: 2, score: 0.4, at: fresh, archived: false },
      ],
      [
        { id: 2, score: 0.9, at: fresh, archived: false },
        { id: 3, score: 0.8, at: old, archived: false },
      ],
      now,
    )
    expect(ranked.map((hit) => hit.id)).toEqual([2, 1, 3])
    expect(ranked.find((hit) => hit.id === 3)?.text).toBe(0)
  })

  it('ranks documents of archived tasks below equal ones of active tasks', () => {
    const now = Date.parse('2026-09-28T12:00:00Z')
    const at = '2026-09-20T00:00:00Z'
    const ranked = fuse(
      [
        { id: 1, score: 1, at, archived: true },
        { id: 2, score: 0.9, at, archived: false },
      ],
      [],
      now,
    )
    expect(ranked.map((hit) => [hit.id, hit.archived])).toEqual([
      [2, false],
      [1, true],
    ])
  })
})

describe('queryWords', () => {
  it('lowercases, drops single letters and repeats', () => {
    expect(queryWords('Did the PII task decide? PII, a b redaction!')).toEqual([
      'did',
      'the',
      'pii',
      'task',
      'decide',
      'redaction',
    ])
  })
})
