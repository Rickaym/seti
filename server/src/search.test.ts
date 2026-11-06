import type { MessageBody, MessagePage, SearchResult, TeamWindow } from '@seti/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { messages, now, sql, tasks } from './db.js'
import { backfillMessageSearch, messageSearch, teamSearch } from './store/search.js'
import { teamMessages, USER_READER } from './store/team.js'
import { assistant, toolResult, toolUse } from './subtask-fixtures.js'
import { USER_AUTH } from './test-auth.js'
import { migrateWith } from './test-migration.js'

const TASK = 'search-task'
const OTHER = 'search-other'
const app = createApp()

const get = async (path: string) => app.request(`/api${path}`, { headers: { host: 'localhost', ...USER_AUTH } })

async function data<T>(path: string): Promise<T> {
  const res = await get(path)
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: T }).data
}

const insert = async (body: MessageBody, taskId = TASK) => (await messages.insert(taskId, body, [])).id

async function indexed(id: number): Promise<string | null> {
  const [row] = await sql<{ body: string }[]>`SELECT body FROM message_search WHERE message_id = ${id}`
  return row?.body ?? null
}

async function talkOf(id: number): Promise<string | null> {
  const [row] = await sql<{ talk: string | null }[]>`SELECT talk FROM message_search WHERE message_id = ${id}`
  return row?.talk ?? null
}

interface SearchOptions {
  mode?: 'text' | 'words'
  before?: number
  limit?: number
  tools?: boolean
}

const search = async (q: string, { mode = 'text', before, limit = 50, tools }: SearchOptions = {}) =>
  messageSearch.search(TASK, { q, mode, before, limit, tools })

const hitIds = (result: SearchResult) => result.hits.map((hit) => hit.id)

const newTask = async (id: string) => {
  await tasks.insert({ id, title: id, repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
}

beforeAll(async () => {
  await newTask(TASK)
  await newTask(OTHER)
})

afterAll(async () => {
  await sql`DELETE FROM team_message`
})

describe('search text extraction', () => {
  it('indexes what each kind of row shows', async () => {
    const prompt = await insert({ kind: 'prompt', payload: { text: 'Please  fix\nthe   login bug' } })
    const auto = await insert({ kind: 'prompt', payload: { text: 'hidden updates text', auto: true } })
    const seti = await insert({ kind: 'seti', payload: { error: 'Claude Code exited unexpectedly' } })
    const shell = await insert({
      kind: 'shell',
      payload: {
        run_id: 'r1',
        command: 'git status --short',
        cwd: '/tmp',
        started_at: now(),
        exit_code: 0,
        signal: null,
        ended_by: null,
        duration_ms: 5,
        stdout: 'M server/src/db.ts',
        stderr: 'warning: CRLF',
      },
    })
    const input = await insert({
      kind: 'input',
      payload: {
        kind: 'pr',
        source: 'pr',
        subject: 'Octocat/seti#42',
        title: 'CI failed on main',
        body: 'lint step exploded',
        url: null,
        message_id: null,
      },
    } as MessageBody)
    expect(await indexed(prompt)).toBe('Please fix the login bug')
    expect(await indexed(auto)).toBeNull()
    expect(await indexed(seti)).toBe('Claude Code exited unexpectedly')
    expect(await indexed(shell)).toBe('git status --short M server/src/db.ts warning: CRLF')
    expect(await indexed(input)).toBe('CI failed on main Octocat/seti#42 lint step exploded')
    expect(await talkOf(prompt)).toBe('Please fix the login bug')
    expect(await talkOf(input)).toBe('CI failed on main Octocat/seti#42 lint step exploded')
    expect([await talkOf(seti), await talkOf(shell)]).toEqual([null, null])
  })

  it('keeps the conversation apart: replies without tool calls, and no tool output', async () => {
    const reply = await insert(
      assistant([
        { type: 'text', text: 'Looking at  the\nlogs.' },
        toolUse('toolu_9', 'Bash', { command: 'cat server.log' }),
        { type: 'text', text: 'Found it.' },
      ]),
    )
    const calls = await insert(assistant([toolUse('toolu_10', 'Read', { file_path: '/src/a.ts' })]))
    const output = await insert(toolResult('toolu_9', 'server.log line one'))
    expect(await talkOf(reply)).toBe('Looking at the logs. Found it.')
    expect([await talkOf(calls), await talkOf(output)]).toEqual([null, null])
    await sql`UPDATE task_message SET payload = ${JSON.stringify(
      assistant([{ type: 'text', text: 'Edited reply' }]).payload,
    )} WHERE id = ${reply}`
    expect(await talkOf(reply)).toBe('Edited reply')
  })

  it('takes assistant text and tool summaries, never thinking or its signature', async () => {
    const id = await insert(
      assistant([
        { type: 'thinking', thinking: 'secret pondering', signature: 'c2lnbmF0dXJlc2lnbmF0dXJl' },
        { type: 'text', text: 'I will run the tests.' },
        toolUse('toolu_1', 'Bash', { command: 'pnpm test --filter server', description: 'Run tests' }),
        toolUse('toolu_2', 'Grep', { pattern: 'needleFn', path: '/src' }),
      ]),
    )
    expect(await indexed(id)).toBe('I will run the tests. Bash pnpm test --filter server Grep needleFn')
  })

  it('takes tool results, trimmed, without images or long unbroken blobs', async () => {
    const blob = 'A'.repeat(500)
    const text = await insert(toolResult('toolu_1', `3 tests failed ${blob} see log`))
    const parts = await insert(
      toolResult('toolu_2', [
        { type: 'text', text: 'first part' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo'.repeat(50) } },
        { type: 'text', text: 'second part' },
      ]),
    )
    const long = await insert(toolResult('toolu_3', 'word '.repeat(2000)))
    expect(await indexed(text)).toBe('3 tests failed see log')
    expect(await indexed(parts)).toBe('first part second part')
    expect((await indexed(long))?.length).toBeLessThanOrEqual(2000)
  })

  it('shows local command output, and skips user text the transcript hides', async () => {
    const local = await insert({
      kind: 'sdk',
      payload: {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: '<local-command-stdout>Compacted 12 messages</local-command-stdout>' },
      },
    })
    const hidden = await insert({
      kind: 'sdk',
      payload: {
        type: 'user',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill' }] },
      },
    })
    expect(await indexed(local)).toBe('Compacted 12 messages')
    expect(await indexed(hidden)).toBeNull()
  })

  it('leaves subagent messages, results and system rows out', async () => {
    const sub = await insert(assistant([{ type: 'text', text: 'subagent words' }], 'toolu_agent'))
    const result = await insert({
      kind: 'sdk',
      payload: { type: 'result', subtype: 'success', is_error: false, result: 'final words', num_turns: 1 },
    } as MessageBody)
    const init = await insert({
      kind: 'sdk',
      payload: { type: 'system', subtype: 'init', model: 'claude', cwd: '/tmp' },
    } as MessageBody)
    expect([await indexed(sub), await indexed(result), await indexed(init)]).toEqual([null, null, null])
  })

  it('follows payload updates and deletes', async () => {
    const id = await insert({ kind: 'prompt', payload: { text: 'before edit', queued: 'waiting' } })
    await sql`UPDATE task_message SET payload = ${JSON.stringify({ text: 'after edit' })} WHERE id = ${id}`
    expect(await indexed(id)).toBe('after edit')
    await sql`UPDATE task_message SET payload = ${JSON.stringify({ text: 'x', auto: true })} WHERE id = ${id}`
    expect(await indexed(id)).toBeNull()
    const gone = await insert({ kind: 'prompt', payload: { text: 'soon gone' } })
    await sql`DELETE FROM task_message WHERE id = ${gone}`
    expect(await indexed(gone)).toBeNull()
  })
})

describe('message search', () => {
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    const texts = {
      plain: 'The deploy finished cleanly',
      upper: 'DEPLOY FAILED with ECONNREFUSED',
      punct: 'Run `pnpm check` (again); then: push!',
      percent: 'coverage is 100% for db_utils',
      backslash: 'path C:\\Users\\seti and a_b_c',
      quote: "it's O'Brien's \"quoted\" text",
      unicode: 'Caf\u00e9 d\u00e9j\u00e0 vu na\u00efve',
      words: 'migrate the database, then deploy the server',
    }
    for (const [key, text] of Object.entries(texts)) {
      ids[key] = await insert({ kind: 'prompt', payload: { text } })
    }
    await insert({ kind: 'prompt', payload: { text: 'deploy from another task' } }, OTHER)
  })

  it('finds substrings in either case, newest first, only in the task', async () => {
    const result = await search('deploy')
    expect(hitIds(result)).toEqual([ids.words, ids.upper, ids.plain])
    expect(result).toMatchObject({ total: 3, has_more: false })
    expect(hitIds(await search('PLOY FA'))).toEqual([ids.upper])
    expect(hitIds(await search('econnref'))).toEqual([ids.upper])
  })

  it('takes punctuation and LIKE wildcards literally', async () => {
    expect(hitIds(await search('`pnpm check` (again);'))).toEqual([ids.punct])
    expect(hitIds(await search('100%'))).toEqual([ids.percent])
    expect(hitIds(await search('db_u'))).toEqual([ids.percent])
    expect(hitIds(await search('%'))).toEqual([ids.percent])
    expect(hitIds(await search('a_b'))).toEqual([ids.backslash])
    expect(hitIds(await search('C:\\Users'))).toEqual([ids.backslash])
    expect(hitIds(await search('O\'Brien\'s "quoted"'))).toEqual([ids.quote])
    expect(hitIds(await search('d\u00e9j\u00e0'))).toEqual([ids.unicode])
  })

  it('treats injection attempts as text', async () => {
    for (const q of ["'; DROP TABLE task_message; --", "' OR '1'='1", '$1) OR (1=1', '\\\\%\\_']) {
      expect((await search(q)).hits).toEqual([])
      expect((await search(q, { mode: 'words' })).hits).toEqual([])
    }
    expect((await sql`SELECT count(*) AS n FROM task_message`)[0]).toBeDefined()
  })

  it('matches whole words in any order in words mode', async () => {
    expect(hitIds(await search('server database', { mode: 'words' }))).toEqual([ids.words])
    expect(hitIds(await search('"deploy the server"', { mode: 'words' }))).toEqual([ids.words])
    expect(hitIds(await search('deploy -server', { mode: 'words' }))).toEqual([ids.upper, ids.plain])
    expect(hitIds(await search('deplo', { mode: 'words' }))).toEqual([])
    expect(hitIds(await search('!!', { mode: 'words' }))).toEqual([])
  })

  it('pages newest first with a keyset cursor', async () => {
    const first = await search('deploy', { limit: 2 })
    expect(hitIds(first)).toEqual([ids.words, ids.upper])
    expect(first).toMatchObject({ total: 2, has_more: true })
    const second = await search('deploy', { limit: 2, before: first.hits.at(-1)?.id ?? 0 })
    expect(hitIds(second)).toEqual([ids.plain])
    expect(second.has_more).toBe(false)
  })

  it('cuts a snippet around the match', async () => {
    const id = await insert({
      kind: 'prompt',
      payload: { text: `${'a '.repeat(200)}the marker word ${'z '.repeat(200)}` },
    })
    const [hit] = (await search('marker word')).hits
    expect(hit?.id).toBe(id)
    expect(hit?.snippet).toMatch(/^\.\.\..*marker word.*\.\.\.$/u)
    expect(hit?.snippet.length).toBeLessThan(220)
  })
})

describe('messages or everything', () => {
  const ids: Record<string, number> = {}

  beforeAll(async () => {
    ids.prompt = await insert({ kind: 'prompt', payload: { text: 'Why does the gravelpit test fail?' } })
    ids.call = await insert(assistant([toolUse('toolu_g1', 'Bash', { command: 'pnpm test gravelpit' })]))
    ids.output = await insert(toolResult('toolu_g1', 'FAIL gravelpit.test.ts'))
    ids.reply = await insert(
      assistant([
        { type: 'text', text: 'The gravelpit fixture is stale.' },
        toolUse('toolu_g2', 'Bash', { command: 'tail gravelpit.log' }),
      ]),
    )
  })

  it('finds only prompts, updates and replies by default, with the snippet from the reply', async () => {
    const result = await search('gravelpit')
    expect(hitIds(result)).toEqual([ids.reply, ids.prompt])
    expect(result.hits[0]?.snippet).toBe('The gravelpit fixture is stale.')
    expect(hitIds(await search('fixture stale', { mode: 'words' }))).toEqual([ids.reply])
    expect(hitIds(await search('tail grav'))).toEqual([])
  })

  it('takes tool calls and their output in when asked', async () => {
    expect(hitIds(await search('gravelpit', { tools: true }))).toEqual([ids.reply, ids.output, ids.call, ids.prompt])
    expect(hitIds(await search('tail grav', { tools: true }))).toEqual([ids.reply])
  })

  it('reads the choice from the route', async () => {
    expect(hitIds(await data<SearchResult>(`/tasks/${TASK}/search?q=gravelpit`))).toEqual([ids.reply, ids.prompt])
    const all = await data<SearchResult>(`/tasks/${TASK}/search?q=gravelpit&tools=true`)
    expect(hitIds(all)).toHaveLength(4)
    expect((await get(`/tasks/${TASK}/search?q=gravelpit&tools=maybe`)).status).toBe(400)
  })
})

describe('search routes', () => {
  it('validates and normalises the query', async () => {
    expect((await get(`/tasks/${TASK}/search?q=a`)).status).toBe(400)
    expect((await get(`/tasks/${TASK}/search?q=${'x'.repeat(201)}`)).status).toBe(400)
    expect((await get(`/tasks/${TASK}/search?q=deploy&mode=fuzzy`)).status).toBe(400)
    const result = await data<SearchResult>(`/tasks/${TASK}/search?q=${encodeURIComponent('  the   deploy ')}`)
    expect(result.hits.map((hit) => hit.snippet)).toEqual(['The deploy finished cleanly'])
  })

  it('refuses archived agents and unknown ones', async () => {
    await newTask('search-archived')
    await sql`UPDATE task SET archived_at = ${now()} WHERE id = 'search-archived'`
    expect((await get('/tasks/search-archived/search?q=deploy')).status).toBe(409)
    expect((await get('/tasks/search-archived/messages?around=5')).status).toBe(409)
    expect((await get('/tasks/missing-task/search?q=deploy')).status).toBe(404)
  })
})

describe('transcript windows', () => {
  const WINDOW = 'window-task'
  const ids: number[] = []

  beforeAll(async () => {
    await newTask(WINDOW)
    for (let i = 0; i < 40; i++) {
      ids.push(await insert({ kind: 'prompt', payload: { text: `row ${String(i)}` } }, WINDOW))
      await insert(assistant([{ type: 'text', text: 'sub' }], 'toolu_sub'), WINDOW)
    }
  })

  const rowIds = (page: MessagePage) => page.messages.map((row) => row.id)

  it('returns own rows centred on the hit', async () => {
    const page = await data<MessagePage>(`/tasks/${WINDOW}/messages?around=${String(ids[20])}&limit=6`)
    expect(rowIds(page)).toEqual(ids.slice(17, 23))
    expect(page).toMatchObject({ has_older: true, has_newer: true })
  })

  it('reports the ends of the transcript', async () => {
    const start = await data<MessagePage>(`/tasks/${WINDOW}/messages?around=${String(ids[1])}&limit=6`)
    expect(rowIds(start)).toEqual(ids.slice(0, 4))
    expect(start).toMatchObject({ has_older: false, has_newer: true })
    const end = await data<MessagePage>(`/tasks/${WINDOW}/messages?around=${String(ids[39])}&limit=6`)
    expect(rowIds(end)).toEqual(ids.slice(36, 40))
    expect(end).toMatchObject({ has_older: true, has_newer: false })
  })

  it('pages forward after a message', async () => {
    const page = await data<MessagePage>(`/tasks/${WINDOW}/messages?after=${String(ids[30])}&limit=5`)
    expect(rowIds(page)).toEqual(ids.slice(31, 36))
    expect(page).toMatchObject({ has_older: true, has_newer: true })
    const last = await data<MessagePage>(`/tasks/${WINDOW}/messages?after=${String(ids[36])}&limit=5`)
    expect(rowIds(last)).toEqual(ids.slice(37))
    expect(last.has_newer).toBe(false)
  })

  it('takes one cursor at a time', async () => {
    expect((await get(`/tasks/${WINDOW}/messages?around=5&before=9`)).status).toBe(400)
  })
})

describe('group chat search', () => {
  const ids: number[] = []

  beforeAll(async () => {
    for (let i = 0; i < 30; i++) {
      const text = i % 10 === 0 ? `Release ${String(i)} shipped @all` : `chatter ${String(i)}`
      ids.push(
        (
          await teamMessages.insert({
            author_kind: 'user',
            author_task_id: null,
            author_handle: null,
            text,
            mentions: [],
          })
        ).id,
      )
    }
  })

  it('finds messages newest first and pages with a cursor', async () => {
    const first = await teamSearch.search(USER_READER, { q: 'release', mode: 'text', limit: 2 })
    expect(hitIds(first)).toEqual([ids[20], ids[10]])
    expect(first.has_more).toBe(true)
    expect(hitIds(await data<SearchResult>(`/team/search?q=shipped&mode=words&before=${String(ids[10])}`))).toEqual([
      ids[0],
    ])
  })

  it('opens a window around a hit', async () => {
    const window = await data<TeamWindow>(`/team/messages?around=${String(ids[15])}&limit=4`)
    expect(window.messages.map((message) => message.id)).toEqual(ids.slice(13, 17))
    expect(window).toMatchObject({ has_older: true, has_newer: true })
    expect((await get(`/team/messages?around=3&after=1`)).status).toBe(400)
  })
})

describe('message_search migration', () => {
  it('creates the index empty, marks where the backfill starts, and indexes new rows', async () => {
    const seed = `INSERT INTO task (id, title, cwd, status, created_at, updated_at)
        VALUES ('old', 'old', '/tmp', 'idle', '', '');
      INSERT INTO task_message (task_id, kind, payload, created_at)
        VALUES ('old', 'prompt', '{"text":"from before"}', '');`
    const outcome = await migrateWith('message_search', seed, async (tx) => {
      const [state] = await tx<{ below: number; max: number }[]>`SELECT below,
        (SELECT MAX(id) FROM task_message) AS max FROM message_search_backfill`
      const before = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM message_search`
      await tx`INSERT INTO task_message (task_id, kind, payload, created_at)
        VALUES ('old', 'prompt', '{"text":"after it"}', '')`
      const after = await tx<{ body: string }[]>`SELECT body FROM message_search`
      return { state, before: before[0]?.n, after: after.map((row) => row.body) }
    })
    expect(outcome.state?.below).toBe((outcome.state?.max ?? 0) + 1)
    expect(outcome.before).toBe(0)
    expect(outcome.after).toEqual(['after it'])
  })
})

describe('message_search_talk migration', () => {
  it('fills the conversation of rows indexed before it', async () => {
    const reply = JSON.stringify(assistant([{ type: 'text', text: 'old reply' }, toolUse('t1', 'Bash', {})]).payload)
    const seed = `INSERT INTO task (id, title, cwd, status, created_at, updated_at)
        VALUES ('old', 'old', '/tmp', 'idle', '', '');
      INSERT INTO task_message (task_id, kind, payload, created_at) VALUES
        ('old', 'prompt', '{"text":"old prompt"}', ''),
        ('old', 'sdk', '${reply}', ''),
        ('old', 'seti', '{"error":"old note"}', '');`
    const talk = await migrateWith('message_search_talk', seed, async (tx) => {
      const rows = await tx<{ talk: string | null }[]>`SELECT talk FROM message_search ORDER BY message_id`
      return rows.map((row) => row.talk)
    })
    expect(talk).toEqual(['old prompt', 'old reply', null])
  })
})

describe('backfill', () => {
  it('indexes older rows in batches, newest first, and stops for good when done', async () => {
    const BACK = 'backfill-task'
    await newTask(BACK)
    const ids: number[] = []
    for (let i = 0; i < 7; i++) {
      ids.push(await insert({ kind: 'prompt', payload: { text: `old row ${String(i)}` } }, BACK))
    }
    await sql`DELETE FROM message_search WHERE task_id = ${BACK}`
    await sql`DELETE FROM message_search_backfill`
    await sql`INSERT INTO message_search_backfill VALUES (${(ids.at(-1) ?? 0) + 1})`
    const fresh = await insert({ kind: 'prompt', payload: { text: 'new row' } }, BACK)

    expect(await backfillMessageSearch(3, 0)).toBeGreaterThanOrEqual(3)
    const rows = await sql<{ message_id: number }[]>`SELECT message_id FROM message_search
      WHERE task_id = ${BACK} ORDER BY message_id`
    expect(rows.map((row) => row.message_id)).toEqual([...ids, fresh])
    expect(await talkOf(ids[0] ?? 0)).toBe('old row 0')
    expect(await sql`SELECT * FROM message_search_backfill`).toHaveLength(0)
    expect(await backfillMessageSearch(3, 0)).toBe(0)
  })
})
