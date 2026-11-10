import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type {
  ArchivedTaskEntry,
  ArchiveReport,
  AuditEvent,
  AutoArchiveStatus,
  MessagePage,
  RestoreReport,
  TaskListEntry,
} from '@seti/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { ArchiveWriter, decodeArchive, type StoredMessage } from './archive-codec.js'
import { archiveTask, archivedPage, autoArchiveCandidates, sweepAutoArchive, unarchiveTask } from './archive.js'
import { messages, repos, sql, tasks } from './db.js'
import { invalidateContext, liveContext } from './ea-context.js'
import { createWorktree } from './git.js'
import { endSession, isRunning, runTurn, sessionState } from './runner.js'
import { auditEvents } from './store/audit.js'
import { eaInbox, eaWatches } from './store/inbox.js'
import { prDiscoveryStore } from './store/pr-discovery.js'
import { prWatch } from './store/pr-watch.js'
import { teamMembers } from './store/team.js'
import { replyToMention } from './team-reply.js'
import { ensureMember, postTeamMessage, teamRoster } from './team.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-archive-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Seti Test',
    GIT_AUTHOR_EMAIL: 'test@seti.invalid',
    GIT_COMMITTER_NAME: 'Seti Test',
    GIT_COMMITTER_EMAIL: 'test@seti.invalid',
  })
  return root
})

/** Turns of tasks in `hang` wait until release() or until the session ends. */
const sdk = await vi.hoisted(async () => {
  const { FakeSdk, fakeResult } = await import('./fake-sdk.js')
  const state = { hang: new Set<string>(), release: new Map<string, () => void>() }
  const fake = new FakeSdk(async function* ({ signal, session }) {
    const task = session.options.env?.SETI_TASK_ID ?? ''
    if (state.hang.has(task)) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve()
        })
        state.release.set(task, resolve)
      })
    }
    yield fakeResult()
  })
  return { state, fake }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.fake.query,
}))

const app = createApp()
const LOCAL = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const DAY = 24 * 60 * 60 * 1000
const created: string[] = []
let taskNumber = 0

const request = async (method: string, route: string, body?: unknown) =>
  app.request(`/api${route}`, {
    method,
    headers: LOCAL,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { data: T }).data
}

const errorOf = async (response: Response) => ((await response.json()) as { error: { detail: string } }).error.detail

async function newTask(title: string, fields: { repo_id?: string; cwd?: string; worktree?: boolean } = {}) {
  taskNumber += 1
  const id = `archive-task-${String(taskNumber)}`
  created.push(id)
  await tasks.insert({
    id,
    title,
    repo_id: fields.repo_id ?? null,
    cwd: fields.cwd ?? scratch,
    worktree: fields.worktree ?? false,
    pr_urls: [],
  })
  return id
}

async function addDoc(taskId: string, body: string): Promise<void> {
  const key = `doc-${taskId}`
  const hash = `hash-${taskId}`
  await sql`INSERT INTO ea_doc (key, scope, kind, task_id, title, body, hash, at)
    VALUES (${key}, ${taskId}, 'result', ${taskId}, '', ${body}, ${hash}, '2026-09-01')`
}

const stored = async (taskId: string) =>
  sql<(StoredMessage & { task_id: string })[]>`SELECT id, task_id, kind, payload, outward, created_at
    FROM task_message WHERE task_id = ${taskId} ORDER BY id`

/** Odd payloads that must survive byte for byte, then a bulk of rows spanning several chunks. */
async function fillTranscript(taskId: string, bulk: number): Promise<void> {
  await messages.insert(
    taskId,
    { kind: 'prompt', payload: { text: 'Gruesse \u00fc \u2713 \u65e5\u672c \ud83d\ude80\ttab\nline' } },
    [],
  )
  await messages.insert(taskId, { kind: 'seti', payload: { error: 'quote " backslash \\ and \u2028 separator' } }, [])
  await sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    VALUES (${taskId}, 'sdk', '{"type":"system", "subtype" :  "note"}', '["toolu_1","toolu_2"]', 'not a time')`
  await sql`INSERT INTO task_message (task_id, kind, payload, outward, created_at)
    SELECT ${taskId}, 'sdk', json_build_object('type', 'assistant', 'parent_tool_use_id', NULL, 'message',
        json_build_object('content', json_build_array(json_build_object('type', 'text',
          'text', repeat('word ' || g, g % 40)))))::text,
      '[]', to_char(timestamp '2026-09-01' + g * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    FROM generate_series(1, ${bulk}) AS g`
}

async function busy(id: string): Promise<void> {
  sdk.state.hang.add(id)
  await runTurn(id, 'Work on it')
  await vi.waitFor(() => {
    expect(sdk.state.release.has(id)).toBe(true)
  })
}

async function release(id: string): Promise<void> {
  sdk.state.hang.delete(id)
  sdk.state.release.get(id)?.()
  sdk.state.release.delete(id)
  await waitIdle(id)
}

function git(cwd: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
}

async function completeTask(title: string, idleDays: number, prState = 'merged'): Promise<string> {
  const id = await newTask(title)
  const url = `https://github.com/acme/app/pull/${String(taskNumber)}`
  await tasks.linkPr(id, url, 'user')
  await sql`INSERT INTO pr_watch (pr_url, snapshot, open, checked_at)
    VALUES (${url}, ${JSON.stringify({ state: prState })}, ${prState === 'open' ? 1 : 0}, ${new Date().toISOString()})`
  await sql`UPDATE task SET updated_at = ${new Date(Date.now() - idleDays * DAY).toISOString()} WHERE id = ${id}`
  return id
}

afterEach(async () => {
  for (const id of created) {
    await endSession(id)
  }
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('archive codec', () => {
  it('round-trips rows through chunks and refuses a changed checksum', async () => {
    const rows: StoredMessage[] = Array.from({ length: 1234 }, (_, i) => ({
      id: 10 + i * 3,
      kind: i % 2 === 0 ? 'sdk' : 'prompt',
      payload: JSON.stringify({ i, text: `row ${String(i)} \u00e9\u2713\n\t` }),
      outward: i % 7 === 0 ? '["x"]' : '[]',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    }))
    const writer = new ArchiveWriter()
    await writer.add(rows.slice(0, 700))
    await writer.add(rows.slice(700))
    const encoded = await writer.finish()
    expect(encoded.chunks.map((chunk) => chunk.rows)).toEqual([500, 500, 234])
    expect(encoded.rows).toBe(1234)
    expect(await decodeArchive(encoded)).toEqual(rows)
    await expect(decodeArchive({ ...encoded, sha256: '0'.repeat(64) })).rejects.toThrow(/checksum/)
    await expect(writer.add([{ ...rows[0], id: 1 } as StoredMessage])).rejects.toThrow(/ascending/)
  })
})

describe('archive and restore', () => {
  it('moves the transcript into one compressed blob and restores it byte for byte', async () => {
    const id = await newTask('Round trip')
    await fillTranscript(id, 1200)
    await addDoc(id, 'decided to ship the widget')
    const before = await stored(id)

    const report = await data<ArchiveReport>(await request('POST', `/tasks/${id}/archive`, {}))

    expect(report).toMatchObject({ task_id: id, rows: 1203, codec: 'zstd', worktrees: [], disk_bytes: 0 })
    expect(report.stored_bytes).toBeLessThan(report.raw_bytes / 4)
    expect(report.table_bytes).toBeGreaterThan(report.stored_bytes)
    expect(await stored(id)).toEqual([])
    const [archive] = await sql<{ row_count: number; sha256: string; storage: string }[]>`SELECT a.row_count,
        a.sha256, (SELECT attstorage FROM pg_attribute WHERE attrelid = 'task_archive'::regclass
          AND attname = 'blob') AS storage
      FROM task_archive a WHERE a.task_id = ${id}`
    expect(archive).toMatchObject({ row_count: 1203, storage: 'e' })
    expect(archive?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect((await tasks.get(id))?.archived_at).not.toBeNull()
    expect((await sql`SELECT archived FROM ea_doc WHERE task_id = ${id}`)[0]).toEqual({ archived: 1 })

    const tail = await archivedPage(id, 100)
    expect(tail.messages.map((row) => row.id)).toEqual(before.slice(-100).map((row) => row.id))
    expect(tail.has_older).toBe(true)
    const pivot = before[700]?.id ?? 0
    const middle = await data<MessagePage>(
      await request('GET', `/tasks/${id}/messages?limit=300&before=${String(pivot)}`),
    )
    expect(middle.messages.map((row) => row.id)).toEqual(before.slice(400, 700).map((row) => row.id))
    const head = await archivedPage(id, 10, before[3]?.id)
    expect(head).toMatchObject({ has_older: false })
    expect(head.messages.map((row) => row.payload)).toEqual(
      before.slice(0, 3).map((row) => JSON.parse(row.payload) as unknown),
    )
    const single = await data<{ outward: string[] }>(
      await request('GET', `/tasks/${id}/messages/${String(before[2]?.id ?? 0)}`),
    )
    expect(single.outward).toEqual(['toolu_1', 'toolu_2'])

    const restored = await data<RestoreReport>(await request('POST', `/tasks/${id}/unarchive`, {}))

    expect(restored).toMatchObject({ task_id: id, rows: 1203, worktrees: [] })
    expect(await stored(id)).toEqual(before)
    expect((await tasks.get(id))?.archived_at).toBeNull()
    expect(await sql`SELECT 1 FROM task_archive WHERE task_id = ${id}`).toEqual([])
    expect((await sql`SELECT archived FROM ea_doc WHERE task_id = ${id}`)[0]).toEqual({ archived: 0 })
    await auditEvents.settled()
    expect(await auditEvents.latest('task.archived')).toMatchObject({
      actor: 'user',
      subject_id: id,
      detail: { rows: 1203, codec: 'zstd' },
    })
    expect(await auditEvents.latest('task.unarchived')).toMatchObject({ actor: 'user', subject_id: id })
    expect((await auditEvents.verify()).ok).toBe(true)
  })

  it('keeps the transcript when the archive fails its checksum on restore', async () => {
    const id = await newTask('Tampered')
    await fillTranscript(id, 10)
    await archiveTask(id, { actor: 'user', removeWorktree: false })
    await sql`UPDATE task_archive SET sha256 = ${'0'.repeat(64)} WHERE task_id = ${id}`

    const response = await request('POST', `/tasks/${id}/unarchive`, {})

    expect(response.status).toBe(500)
    expect(await errorOf(response)).toMatch(/checksum/)
    expect(await stored(id)).toEqual([])
    expect((await tasks.get(id))?.archived_at).not.toBeNull()
  })

  it('refuses a working agent, and closes the session of an idle one', async () => {
    const id = await newTask('Busy agent')
    await busy(id)
    const refused = await request('POST', `/tasks/${id}/archive`, {})
    expect(refused.status).toBe(409)
    expect(await errorOf(refused)).toMatch(/stop it first/)
    await release(id)
    expect(sessionState(id).open).toBe(true)

    await data<ArchiveReport>(await request('POST', `/tasks/${id}/archive`, { remove_worktree: false }))

    expect(sessionState(id)).toEqual({ open: false, background: 0 })
    expect(isRunning(id)).toBe(false)
    const again = await request('POST', `/tasks/${id}/archive`, {})
    expect(again.status).toBe(409)
  })

  it('refuses work for an archived agent from every direction', async () => {
    const id = await newTask('Resting agent')
    await archiveTask(id, { actor: 'user', removeWorktree: false })

    const sent = await request('POST', `/tasks/${id}/messages`, { prompt: 'hello' })
    expect(sent.status).toBe(409)
    expect(await errorOf(sent)).toBe('Agent "Resting agent" is archived; restore it first')
    expect((await request('PATCH', `/tasks/${id}`, { title: 'Renamed' })).status).toBe(409)
    expect((await request('POST', '/ea/watches', { task_id: id, note: '' })).status).toBe(409)
    await expect(runTurn(id, 'hello')).rejects.toThrow(/archived/)
    expect((await request('GET', `/tasks/${id}`)).status).toBe(200)
    expect((await request('DELETE', `/tasks/${id}`)).status).toBe(204)
  })

  it('archives and reports several agents at once', async () => {
    const first = await newTask('Bulk one')
    const second = await newTask('Bulk two')
    await busy(second)
    const result = await data<{ archived: ArchiveReport[]; refused: { task_id: string }[] }>(
      await request('POST', '/tasks/archive', { task_ids: [first, second, 'missing'] }),
    )
    expect(result.archived.map((report) => report.task_id)).toEqual([first])
    expect(result.refused.map((entry) => entry.task_id)).toEqual([second, 'missing'])
    await release(second)
    expect((await request('POST', '/tasks/archive', { task_ids: [] })).status).toBe(400)
  })
})

describe('what an archived agent is left out of', () => {
  it('leaves the task list, status counts, poller, discovery, EA context and watches', async () => {
    const archived = await newTask('Archived widget work')
    const active = await newTask('Active widget work')
    const shared = 'https://github.com/acme/app/pull/501'
    const own = 'https://github.com/acme/app/pull/502'
    for (const [task, url] of [
      [archived, shared],
      [active, shared],
      [archived, own],
    ] as const) {
      await tasks.linkPr(task, url, 'user')
    }
    await eaWatches.add(archived, 'keep an eye', new Date().toISOString())
    await sql`UPDATE task SET status = 'error' WHERE id = ${archived}`
    expect(await prWatch.watched()).toEqual(expect.arrayContaining([shared, own]))

    await archiveTask(archived, { actor: 'user', removeWorktree: false })

    const listed = await data<TaskListEntry[]>(await request('GET', '/tasks'))
    expect(listed.map((task) => task.id)).toContain(active)
    expect(listed.map((task) => task.id)).not.toContain(archived)
    const archivedList = await data<ArchivedTaskEntry[]>(await request('GET', '/tasks/archived'))
    expect(archivedList.find((task) => task.id === archived)?.archive).toMatchObject({ actor: 'user', rows: 0 })
    const watched = await prWatch.watched()
    expect(watched).toContain(shared)
    expect(watched).not.toContain(own)
    expect(await prWatch.listeners(shared)).toEqual([{ task_id: active, tool_use_id: null }])
    expect(await prWatch.listeners(own)).toEqual([])
    expect(await prWatch.eaWatchers(own)).toEqual([])
    expect(await eaWatches.list()).toEqual([])
    expect(await prDiscoveryStore.taskIds()).not.toContain(archived)
    invalidateContext(true)
    const context = await liveContext()
    expect(context.tasks.map((task) => task.id)).not.toContain(archived)
    expect(context.text).not.toContain('Archived widget work')
    expect(sessionState(archived).open).toBe(false)

    await unarchiveTask(archived)

    expect(await prWatch.watched()).toContain(own)
    expect(await prWatch.listeners(own)).toEqual([{ task_id: archived, tool_use_id: null }])
    expect((await eaWatches.list()).map((watch) => watch.task_id)).toEqual([archived])
    expect(await prDiscoveryStore.taskIds()).toContain(archived)
  })

  it('takes the agent out of the group chat and refuses mentions of its handle', async () => {
    const archived = await newTask('Voicemail detection')
    const active = await newTask('Billing export')
    const handle = (await ensureMember({ id: archived, title: 'Voicemail detection' })).handle
    await ensureMember({ id: active, title: 'Billing export' })
    await archiveTask(archived, { actor: 'user', removeWorktree: false })

    expect((await teamRoster()).map((member) => member.task_id)).not.toContain(archived)
    const posted = await postTeamMessage({ kind: 'user' }, `@${handle} and @all: status?`)

    expect(posted.archived).toEqual([handle])
    expect(posted.unknown).toEqual([])
    expect(posted.deliveries.map((delivery) => delivery.task_id)).not.toContain(archived)
    expect(posted.deliveries.map((delivery) => delivery.task_id)).toContain(active)
    const newTitle = await newTask('Voicemail again')
    expect((await ensureMember({ id: newTitle, title: 'Voicemail again' })).handle).not.toBe(handle)

    await unarchiveTask(archived)

    expect((await teamMembers.get(archived))?.handle).toBe(handle)
    expect((await teamRoster()).map((member) => member.task_id)).toContain(archived)
    await vi.waitFor(async () => {
      await waitIdle(active)
    })
  })

  it('drops the urgency of its @ea mentions and leaves it out of the EA reply', async () => {
    const id = await newTask('Release notes')
    await ensureMember({ id, title: 'Release notes' })
    const asked = await postTeamMessage({ kind: 'task', taskId: id }, '@ea may I publish?')
    await archiveTask(id, { actor: 'user', removeWorktree: false })

    const due = await eaInbox.due(new Date(Date.now() + 1000).toISOString(), 10)
    expect(due.find((item) => item.message_id === asked.message.id)?.urgent).toBe(false)
    const reply = await replyToMention(asked.message.id, 'Yes, go ahead.')
    expect(reply.deliveries).toEqual([])
    expect(reply.archived).toEqual([asked.message.author_handle])
  })

  it('keeps search documents findable, flagged archived', async () => {
    const id = await newTask('Search')
    await addDoc(id, 'the flamingo migration plan')
    await archiveTask(id, { actor: 'user', removeWorktree: false })
    const found = await data<{ hits: { task_id: string; archived: boolean }[] }>(
      await request('GET', '/ea/search?q=flamingo%20migration&mode=text'),
    )
    expect(found.hits).toEqual([expect.objectContaining({ task_id: id, archived: true })])
  })
})

describe('worktrees', () => {
  const origin = path.join(scratch, 'origin.git')
  const checkout = path.join(scratch, 'checkout')

  async function worktreeTask(name: string): Promise<{ id: string; dir: string }> {
    if (!fs.existsSync(checkout)) {
      git(scratch, 'init', '--bare', '--initial-branch=main', origin)
      git(scratch, 'init', '--initial-branch=main', checkout)
      fs.writeFileSync(path.join(checkout, 'README.md'), '# scratch\n')
      git(checkout, 'add', 'README.md')
      git(checkout, 'commit', '-m', 'chore: seed')
      git(checkout, 'remote', 'add', 'origin', origin)
      git(checkout, 'push', '-u', 'origin', 'main')
      await repos.insert({ id: 'repo-wt', slug: 'acme/wt', path: checkout, base_branch: 'main', created_at: '2026' })
    }
    const dir = await createWorktree(checkout, 'main', name)
    git(dir, 'checkout', '-b', `feat/${name}`)
    fs.writeFileSync(path.join(dir, `${name}.txt`), name)
    git(dir, 'add', '.')
    git(dir, 'commit', '-m', `feat: ${name}`)
    return { id: await newTask(`Worktree ${name}`, { repo_id: 'repo-wt', cwd: dir, worktree: true }), dir }
  }

  it('frees a clean, pushed worktree and checks its branch out again on restore', async () => {
    const { id, dir } = await worktreeTask('pushed')
    git(dir, 'push', '-u', 'origin', 'feat/pushed')

    const report = await archiveTask(id, { actor: 'user', removeWorktree: true })

    expect(report.worktrees).toEqual([
      expect.objectContaining({ dir, removed: true, kept_because: null, branch: 'feat/pushed' }),
    ])
    expect(report.disk_bytes).toBeGreaterThan(0)
    expect(fs.existsSync(dir)).toBe(false)

    const restored = await unarchiveTask(id)

    expect(restored.worktrees).toEqual([{ repo: 'acme/wt', dir, recreated: true }])
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('feat/pushed')
    expect(fs.readFileSync(path.join(dir, 'pushed.txt'), 'utf8')).toBe('pushed')
  })

  it('keeps worktrees with uncommitted changes or an unpushed commit on no branch and says why', async () => {
    const dirty = await worktreeTask('dirty')
    git(dirty.dir, 'push', '-u', 'origin', 'feat/dirty')
    fs.writeFileSync(path.join(dirty.dir, 'draft.txt'), 'unsaved')
    const detached = await worktreeTask('detached')
    git(detached.dir, 'checkout', '--detach')

    const kept = await archiveTask(dirty.id, { actor: 'user', removeWorktree: true })
    const loose = await archiveTask(detached.id, { actor: 'user', removeWorktree: true })

    expect(kept.worktrees[0]).toMatchObject({ removed: false, kept_because: 'it has uncommitted changes' })
    expect(loose.worktrees[0]).toMatchObject({
      removed: false,
      kept_because: 'its commit is on no branch and not pushed',
    })
    expect(fs.existsSync(dirty.dir) && fs.existsSync(detached.dir)).toBe(true)
    expect((await unarchiveTask(dirty.id)).worktrees).toEqual([{ repo: 'acme/wt', dir: dirty.dir, recreated: false }])
  })

  it('frees a clean worktree whose commits sit on a local branch, which stays', async () => {
    const { id, dir } = await worktreeTask('unpushed')

    const report = await archiveTask(id, { actor: 'user', removeWorktree: true })

    expect(report.worktrees[0]).toMatchObject({ removed: true, branch: 'feat/unpushed' })
    expect(git(checkout, 'branch', '--list', 'feat/unpushed')).toContain('feat/unpushed')
    await unarchiveTask(id)
    expect(fs.readFileSync(path.join(dir, 'unpushed.txt'), 'utf8')).toBe('unpushed')
  })
})

describe('auto archive', () => {
  const statusOf = async () => data<AutoArchiveStatus>(await request('GET', '/archive/settings'))

  it('archives COMPLETE agents idle long enough, and nothing that waits on anything', async () => {
    const old = await completeTask('Old and done', 5)
    const recent = await completeTask('Recently done', 1)
    const open = await completeTask('PR still open', 5, 'open')
    const waiting = await completeTask('Update waiting', 5)
    await messages.insert(
      waiting,
      {
        kind: 'input',
        payload: { source: 'pr', kind: 'ci_failed', subject: 'acme/app#9', title: 'CI failed', body: '', url: null },
      },
      [],
    )
    const mentioned = await completeTask('Mentioned since', 5)
    const handle = (await ensureMember({ id: mentioned, title: 'Mentioned since' })).handle
    await teamMembers.setMuted(mentioned, true)
    await postTeamMessage({ kind: 'user' }, `@${handle} are you there?`)
    const pinned = await completeTask('Pinned and done', 5)
    await tasks.setPinned(pinned, true)
    const running = await completeTask('Still running', 5)
    await busy(running)
    await sql`UPDATE task SET updated_at = ${new Date(Date.now() - 5 * DAY).toISOString()} WHERE id = ${running}`

    const status = await statusOf()
    expect(status.settings).toEqual({
      enabled: true,
      days: 3,
      delete_after_days: null,
      resume_after_restart: true,
      repeat_guard: true,
      updated_at: null,
    })
    expect(status.preview).toEqual({ count: 1, tasks: [expect.objectContaining({ id: old, title: 'Old and done' })] })

    const off = await request('PUT', '/archive/settings', { enabled: false, days: 3 })
    expect((await data<AutoArchiveStatus>(off)).settings).toMatchObject({ enabled: false, days: 3 })
    expect(await sweepAutoArchive('system')).toEqual({ archived: [], failed: [] })
    await data(await request('PUT', '/archive/settings', { enabled: true, days: 3 }))

    const swept = await sweepAutoArchive('system')

    expect(swept.archived.map((report) => report.task_id)).toEqual([old])
    for (const kept of [recent, open, waiting, mentioned, running]) {
      expect((await tasks.get(kept))?.archived_at).toBeNull()
    }
    expect(await sweepAutoArchive('system')).toEqual({ archived: [], failed: [] })
    expect(await autoArchiveCandidates(3)).toEqual([])
    await auditEvents.settled()
    const archivedAudit = await auditEvents.latest('task.archived')
    expect(archivedAudit).toMatchObject({
      actor: 'system',
      subject_id: old,
      detail: { rule: 'auto_archive', rule_days: 3 },
    } satisfies Partial<AuditEvent>)
    expect(archivedAudit?.summary).toContain('(COMPLETE and idle 3+ days)')
    const changes = (await auditEvents.page({ kind: 'system.auto_archive_changed', limit: 10 })).events
    expect(changes.map((event) => event.summary)).toEqual([
      'Set auto archive on, for COMPLETE agents idle 3 days or more',
      'Set auto archive off',
    ])
    await release(running)
  })

  it('lets the user run the rule while it is off, and checks its input', async () => {
    const id = await completeTask('Done a while ago', 10)
    await data(await request('PUT', '/archive/settings', { enabled: false, days: 7 }))
    expect((await statusOf()).preview.count).toBe(1)
    const swept = await data<{ archived: ArchiveReport[] }>(await request('POST', '/archive/sweep', {}))
    expect(swept.archived.map((report) => report.task_id)).toEqual([id])
    expect((await statusOf()).archived.count).toBeGreaterThan(0)
    expect((await request('PUT', '/archive/settings', { enabled: true, days: 0 })).status).toBe(400)
    await data(await request('PUT', '/archive/settings', { enabled: true, days: 3 }))
  })

  it('turns Resume after restart off alone and keeps the rule', async () => {
    const off = await data<AutoArchiveStatus>(
      await request('PUT', '/archive/settings', { resume_after_restart: false }),
    )
    expect(off.settings).toMatchObject({ enabled: true, days: 3, resume_after_restart: false })
    await auditEvents.settled()
    expect(await auditEvents.latest('system.auto_archive_changed')).toMatchObject({
      summary: expect.stringContaining('resume after restart off') as unknown,
    })
    await data(await request('PUT', '/archive/settings', { resume_after_restart: true }))
  })
})

describe('migration', () => {
  it('adds the archive columns and tables', async () => {
    const columns = await sql<{ table_name: string; column_name: string }[]>`SELECT table_name, column_name
      FROM information_schema.columns
      WHERE (table_name = 'task' AND column_name = 'archived_at') OR (table_name = 'ea_doc' AND column_name = 'archived')
        OR table_name IN ('task_archive', 'archive_settings')
      ORDER BY table_name, column_name`
    expect(new Set(columns.map((column) => column.table_name))).toEqual(
      new Set(['archive_settings', 'ea_doc', 'task', 'task_archive']),
    )
    const [applied] = await sql`SELECT name FROM schema_migration WHERE version = 9`
    expect(applied).toEqual({ name: 'task_archive' })
  })
})
