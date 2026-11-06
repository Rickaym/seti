import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { messageSearch, type ChatSearch } from './store/search.js'

const BIG = 'search-scale-task'
const SMALL = 'search-scale-small'
const ROWS = 200_000
const GIN_INDEXES = [
  'message_search_trgm',
  'message_search_words',
  'message_search_talk_trgm',
  'message_search_talk_words',
]

/** Fills a long transcript with GIN indexes rebuilt after the load, as a restore would build them. */
async function seed(taskId: string, rows: number): Promise<void> {
  await sql`INSERT INTO task_message (task_id, kind, payload, created_at)
    SELECT ${taskId}, 'prompt', json_build_object('text', concat_ws(' ', 'step', g, md5(g::text),
      CASE WHEN g % 2 = 0 THEN 'the build passed' ELSE 'tests ran' END,
      CASE WHEN g % 50000 = 7 THEN 'rare-needle found' END))::text, '2026-01-01T00:00:00Z'
    FROM generate_series(1, ${rows}) AS g`
}

const plan = async (search: Partial<ChatSearch> & { q: string }) =>
  messageSearch.plan(BIG, { mode: 'text', limit: 100, ...search })

beforeAll(async () => {
  await tasks.insert({ id: BIG, title: 'big', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  await tasks.insert({ id: SMALL, title: 'small', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
  const definitions = await sql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes
    WHERE indexname = ANY(${GIN_INDEXES})`
  await sql.unsafe(`DROP INDEX ${GIN_INDEXES.join(', ')}`)
  await seed(SMALL, 2000)
  await seed(BIG, ROWS)
  for (const { indexdef } of definitions) {
    await sql.unsafe(indexdef)
  }
  await sql`ANALYZE message_search`
}, 300_000)

describe('search on a 200k-row transcript', () => {
  it('finds a rare substring through the trigram index, in messages or in everything', async () => {
    const shown = await plan({ q: 'rare-needle' })
    expect(shown).toContain('message_search_talk_trgm')
    expect(shown).not.toContain('Seq Scan')
    const result = await messageSearch.search(BIG, { q: 'RARE-needle', mode: 'text', limit: 100 })
    expect(result.hits).toHaveLength(4)
    const everything = await plan({ q: 'rare-needle', tools: true })
    expect(everything).toContain('message_search_trgm')
    expect(everything).not.toContain('Seq Scan')
  })

  it('finds whole words through the tsvector index, in messages or in everything', async () => {
    const shown = await plan({ q: 'needle found', mode: 'words' })
    expect(shown).toContain('message_search_talk_words')
    expect(shown).not.toContain('Seq Scan')
    const everything = await plan({ q: 'needle found', mode: 'words', tools: true })
    expect(everything).toContain('message_search_words')
    expect(everything).not.toContain('Seq Scan')
  })

  it('walks the task newest first for a common term instead of reading every match', async () => {
    const shown = await plan({ q: 'build passed' })
    expect(shown).toMatch(/Index Scan Backward using message_search_(task|pkey)/u)
    expect(shown).not.toContain('Seq Scan')
    const result = await messageSearch.search(BIG, { q: 'build passed', mode: 'text', limit: 100 })
    expect(result).toMatchObject({ total: 100, has_more: true })
  })

  it('keeps using the index on a page halfway back', async () => {
    const [row] = await sql<{ id: number }[]>`SELECT min(message_id) + ${ROWS / 2} AS id FROM message_search
      WHERE task_id = ${BIG}`
    const shown = await plan({ q: 'rare-needle', before: row?.id ?? 0 })
    expect(shown).toContain('message_search_talk_trgm')
    expect(shown).not.toContain('Seq Scan')
  })
})
