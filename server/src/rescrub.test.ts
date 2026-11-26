import { beforeAll, describe, expect, it } from 'vitest'
import { sql, tasks } from './db.js'
import { rescrubStoredRows, scrubStoredPayload } from './store/rescrub.js'
import { migrateWith } from './test-migration.js'

const TASK = 'rescrub-task'

/** Fake session material is assembled at run time, so secret scanners do not flag this file. */
const sessionBlob = () =>
  `base64-${Buffer.from(JSON.stringify({ access_token: 'a.b.c', refresh_token: ['rTkn', '12345678'].join('') })).toString('base64')}`
const cookieLine = (blob: string) => `cookie: sb-abcdefghijklmnopqrst-auth-token=${blob}; theme=dark`

const toolResult = (text: string) =>
  JSON.stringify({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] },
  })

async function legacyRow(payload: string): Promise<number> {
  const [row] = await sql<{ id: number }[]>`INSERT INTO task_message (task_id, kind, payload, created_at)
    VALUES (${TASK}, 'sdk', ${payload}, '2026-11-01T00:00:00.000Z') RETURNING id`
  return row?.id ?? 0
}

const payloadOf = async (id: number) =>
  (await sql<{ payload: string }[]>`SELECT payload FROM task_message WHERE id = ${id}`).at(0)?.payload ?? ''

async function startSweep(below: number): Promise<void> {
  await sql`DELETE FROM scrub_backfill`
  await sql`INSERT INTO scrub_backfill (target, below) VALUES ('task_message', ${below})`
  await sql`INSERT INTO scrub_backfill (target, after_id) VALUES ('permission_request', '')`
}

beforeAll(async () => {
  await tasks.insert({ id: TASK, title: 'Rescrub', repo_id: null, cwd: '/tmp', worktree: false, pr_urls: [] })
})

describe('session_rescrub migration', () => {
  it('starts the sweep above every stored transcript row and before every request', async () => {
    const seed = `INSERT INTO task (id, title, cwd, status, created_at, updated_at) VALUES ('old', 'old', '/tmp', 'idle', '', '');
      INSERT INTO task_message (task_id, kind, payload, created_at) VALUES ('old', 'prompt', '{"text":"x"}', '');`
    const state = await migrateWith('session_rescrub', seed, async (tx) => ({
      rows: await tx<{ target: string; below: number | null; after_id: string | null }[]>`SELECT target, below, after_id
        FROM scrub_backfill ORDER BY target`,
      max: (await tx<{ max: number }[]>`SELECT MAX(id) AS max FROM task_message`).at(0)?.max ?? 0,
    }))
    expect(state.rows).toEqual([
      { target: 'permission_request', below: null, after_id: '' },
      { target: 'task_message', below: state.max + 1, after_id: null },
    ])
  })
})

describe('scrubStoredPayload', () => {
  it('keeps a clean payload byte for byte and rewrites one that holds a session', () => {
    const clean = toolResult('npm test\n 2 passed')
    expect(scrubStoredPayload(clean)).toBe(clean)
    const blob = sessionBlob()
    const out = scrubStoredPayload(toolResult(cookieLine(blob)))
    expect(out).not.toContain(blob.slice(7, 40))
    expect(out).toContain('auth-token=[redacted]; theme=[redacted]')
  })

  it('redacts a payload that is not JSON as text', () => {
    expect(scrubStoredPayload(cookieLine(sessionBlob()))).toContain('auth-token=[redacted]')
  })
})

describe('rescrubStoredRows', () => {
  it('redacts stored rows and requests below the cursor, resumes from it and counts, then stops', async () => {
    const blob = sessionBlob()
    const leaked = await legacyRow(toolResult(cookieLine(blob)))
    const clean = await legacyRow(toolResult('git status\nnothing to commit'))
    const later = await legacyRow(toolResult(cookieLine(blob)))
    const input = JSON.stringify({ command: `curl -b 'sid=${['s3ss', '10n42xyz'].join('')}' https://x.test` }, null, 2)
    await sql`INSERT INTO permission_request (id, task_id, tool_name, summary, input, created_at)
      VALUES ('rescrub-request', ${TASK}, 'Bash', 'curl', ${input}, '2026-11-01T00:00:00.000Z')`
    const cleanBefore = await payloadOf(clean)
    await startSweep(later)

    const counts = await rescrubStoredRows(2, 0)

    expect(await payloadOf(leaked)).not.toContain(blob.slice(7, 40))
    expect(await payloadOf(clean)).toBe(cleanBefore)
    expect(await payloadOf(later)).toContain(blob.slice(7, 40))
    const [request] = await sql<{ input: string }[]>`SELECT input FROM permission_request WHERE id = 'rescrub-request'`
    expect(request?.input).toContain(`sid=[redacted]`)
    const byTarget = new Map(counts?.map((count) => [count.target, count]))
    expect(byTarget.get('task_message')?.changed).toBeGreaterThanOrEqual(1)
    expect(byTarget.get('task_message')?.checked).toBeGreaterThanOrEqual(2)
    expect(byTarget.get('permission_request')?.changed).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(counts)).not.toContain(blob.slice(7, 40))
    expect(await sql`SELECT * FROM scrub_backfill`).toHaveLength(0)
    expect(await rescrubStoredRows(2, 0)).toBeNull()
  })
})
