import { beforeAll, describe, expect, it } from 'vitest'
import { messages, sql } from './db.js'
import { storedColumns } from './events/columns.js'
import { goldenCorpus } from './golden/corpus.js'
import { activity } from './store/activity.js'
import { costSince } from './store/cost.js'
import { eaContextStore } from './store/ea-context.js'
import { fillEventColumns } from './store/event-columns.js'
import { homeStore } from './store/home.js'
import { prDiscoveryStore } from './store/pr-discovery.js'
import { latestSessionInit } from './store/sessions.js'
import { subtaskMessages } from './store/subtasks.js'

const corpus = goldenCorpus()
const taskIds = corpus.map(({ name }) => name)
const LAST = Number.MAX_SAFE_INTEGER
const OPEN = { from: null, to: null }

/** Every subagent call id the corpus holds, for the subagent page. */
const threads = [
  ...new Set(
    corpus.flatMap(({ rows }) =>
      rows.flatMap((row) => {
        const parent = (row.payload as { parent_tool_use_id?: unknown }).parent_tool_use_id
        return typeof parent === 'string' ? [parent] : []
      }),
    ),
  ),
]

beforeAll(async () => {
  for (const { name, rows } of corpus) {
    await sql`INSERT INTO task (id, title, cwd, status, created_at, updated_at)
      VALUES (${name}, ${name}, '/tmp', 'idle', ${rows[0]?.created_at ?? ''}, ${rows[0]?.created_at ?? ''})`
    for (const row of rows) {
      await sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
        VALUES (${name}, ${row.kind}, ${JSON.stringify(row.payload)}, '[]', ${row.created_at})`
    }
  }
})

/** What one task's readers return, for every reader that filters on the event columns. */
async function readTask(taskId: string) {
  const [middle] = await sql<{ id: number }[]>`SELECT id FROM task_message WHERE task_id = ${taskId}
    ORDER BY id OFFSET 10 LIMIT 1`
  return {
    page: await messages.page(taskId, 500),
    pageBefore: await messages.page(taskId, 5, (middle?.id ?? 0) + 3),
    pageAfter: await messages.pageAfter(taskId, 7, middle?.id ?? 0),
    around: await messages.around(taskId, 9, middle?.id ?? 0),
    dropped: await messages.droppedPrompt(taskId, 'resent'),
    ending: await messages.turnEnding(taskId),
    subtasks: await subtaskMessages.page(taskId, threads, 500),
    windowRows: await activity.rows(taskId, OPEN, { before: LAST, talkOnly: false, limit: 500 }),
    talkRows: await activity.rows(taskId, OPEN, { before: LAST, talkOnly: true, limit: 500 }),
    session: await latestSessionInit(taskId),
    evidence: await prDiscoveryStore.evidenceRows(taskId, LAST),
  }
}

/** What every reader that filters on the event columns returns over the whole table. */
async function readAll() {
  return {
    tasks: await Promise.all(taskIds.map(readTask)),
    active: await activity.active(OPEN),
    cost: cents(await costSince('')),
    days: (await homeStore.turnDays('', 'UTC', 0)).map((day) => ({ ...day, cost_usd: cents(day.cost_usd) })),
    recent: Object.fromEntries(await eaContextStore.recentActivity(taskIds, 12)),
    notable: await eaContextStore.notable(200),
  }
}

/** Sums of floats differ in the last digits with the order rows are summed in, so compare cents. */
const cents = (usd: number) => Math.round(usd * 100)

const unfill = async (where: ReturnType<typeof sql>) =>
  sql`UPDATE task_message SET runtime = NULL, thread = NULL, event = NULL, agent = NULL, turn_usd = NULL,
    turn_ms = NULL, turn_steps = NULL, turn_reply = NULL WHERE ${where}`

describe('readers over rows the fill has not reached', () => {
  it('read a table of unfilled, partly filled and filled rows the same', async () => {
    const unfilled = await readAll()
    expect(await fillEventColumns(sql, 100, 0)).toBeGreaterThan(250)
    const filled = await readAll()
    expect(unfilled).toEqual(filled)

    await unfill(sql`id % 2 = 0 OR task_id = ${taskIds[0] ?? ''}`)
    expect(await readAll()).toEqual(filled)

    await fillEventColumns(sql, 100, 0)
    const [newest] = await sql<{ id: number }[]>`SELECT id FROM task_message ORDER BY id OFFSET 150 LIMIT 1`
    await unfill(sql`id < ${newest?.id ?? 0}`)
    expect(await readAll()).toEqual(filled)
  })

  it('resumes a fill cut short where it stopped and fills each row as ingest would', async () => {
    await fillEventColumns(sql, 100, 0)
    const [cut] = await sql<{ id: number }[]>`SELECT id FROM task_message ORDER BY id DESC OFFSET 99 LIMIT 1`
    await unfill(sql`id < ${cut?.id ?? 0}`)
    const [left] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM task_message
      WHERE runtime IS NULL`
    expect(left?.count).toBeGreaterThan(150)
    expect(await fillEventColumns(sql, 64, 0)).toBe(left?.count)
    const rows = await sql<({ kind: string; payload: string } & Record<string, unknown>)[]>`SELECT kind, payload,
        runtime, thread, event, agent, turn_usd, turn_ms, turn_steps, turn_reply FROM task_message`
    for (const { kind, payload, ...stored } of rows) {
      expect(stored).toEqual(storedColumns(kind, payload))
    }
  })
})
