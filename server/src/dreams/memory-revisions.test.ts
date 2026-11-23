import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AuditPage, Revision, UnseenChange } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { tasks } from '../db.js'
import { claudeMemory } from '../runtimes/claude/dream.js'
import { taskArchives } from '../store/archive.js'
import { USER_AUTH } from '../test-auth.js'
import { recordMemoryChanges } from './memory-revisions.js'
import { snapshotMemory, type MemorySnapshot } from './memory-snapshot.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-memory-revisions-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

vi.mock('../runner.js', () => ({
  runTurn: () => undefined,
  stopTurn: async () => Promise.resolve(),
  endSession: async () => Promise.resolve(),
  isRunning: () => false,
  registerContextProvider: () => undefined,
  registerSessionMcpServers: () => undefined,
  registerTurnPreface: () => undefined,
  onTurnEnd: () => undefined,
  subscribe: () => () => undefined,
}))

const app = createApp()

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  const parsed = text === '' ? null : (JSON.parse(text) as { data?: T; error?: { detail: string } })
  return { status: res.status, data: (parsed?.data ?? parsed?.error?.detail ?? null) as T }
}

/** A new agent with its own working folder and memory folder files. */
async function agent(files: Record<string, string>): Promise<{ id: string; dir: string }> {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  fs.mkdirSync(cwd, { recursive: true })
  await tasks.insert({ id, title: `Agent ${id.slice(0, 4)}`, repo_id: null, cwd, worktree: false, pr_urls: [] })
  const dir = claudeMemory(cwd)
  write(dir, files)
  return { id, dir }
}

function write(dir: string, files: Record<string, string | null>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name)
    if (text === null) {
      fs.rmSync(file)
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
  }
}

async function snapshot(dir: string): Promise<MemorySnapshot> {
  const result = await snapshotMemory(dir)
  if (!result.ok) {
    throw new Error(result.reason)
  }
  return result.files
}

/** Snapshots, changes the files as a dream would, and records the difference. */
async function dream(id: string, dir: string, changes: Record<string, string | null>) {
  const before = await snapshot(dir)
  write(dir, changes)
  return recordMemoryChanges(id, 'dream 2026-11-24', before, await snapshot(dir))
}

const historyOf = async (id: string) =>
  (await send<Revision[]>('GET', `/revisions?object_type=memory_file&task_id=${id}`)).data

const revert = async (revision: number | null | undefined) =>
  send<Revision>('POST', `/revisions/${String(revision)}/revert`, {})

describe('memory revisions', () => {
  it('records each changed, created and deleted file as a revision by Seti and audits it', async () => {
    const { id, dir } = await agent({ 'MEMORY.md': '- a\n- b\n', 'old.md': 'stale\n', 'same.md': 'kept\n' })
    const recorded = await dream(id, dir, { 'MEMORY.md': '- a\n- c\n- d\n', 'old.md': null, 'topics/new.md': 'new\n' })
    expect(recorded.map(({ file, added, removed }) => [file, added, removed])).toEqual([
      ['MEMORY.md', 2, 1],
      ['old.md', 0, 1],
      ['topics/new.md', 1, 0],
    ])
    const history = await historyOf(id)
    expect(history.map((r) => [r.object_id, r.actor, r.kind, r.task_id, r.reason])).toEqual([
      [`${id}:topics/new.md`, 'system', 'updated', id, 'dream 2026-11-24'],
      [`${id}:old.md`, 'system', 'updated', id, 'dream 2026-11-24'],
      [`${id}:MEMORY.md`, 'system', 'updated', id, 'dream 2026-11-24'],
    ])
    expect(history[1]?.after).toEqual({ text: '', sha256: '', deleted: true })
    const audit = await send<AuditPage>('GET', '/audit?kind=dream.memory_changed&limit=3')
    const memory = audit.data.events.find((e) => e.detail.path === 'MEMORY.md' && e.subject_id === id)
    expect(memory?.detail).toMatchObject({ added: 2, removed: 1, bytes_before: 8, bytes_after: 12 })
    expect(JSON.stringify(audit.data.events)).not.toContain('- c')
    const unseen = (await send<UnseenChange[]>('GET', '/revisions/unseen')).data
    expect(unseen.filter((u) => u.task_id === id)).toHaveLength(3)
  })

  it('records nothing when the dream changed nothing', async () => {
    const { id, dir } = await agent({ 'MEMORY.md': '- a\n' })
    expect(await dream(id, dir, { 'MEMORY.md': '- a\n' })).toEqual([])
  })

  it('keeps credentials out of the stored text and refuses to put a redacted text back', async () => {
    const token = `ghp_${'x'.repeat(36)}`
    const { id, dir } = await agent({ 'MEMORY.md': `- deploy with ${token}\n` })
    const [change] = await dream(id, dir, { 'MEMORY.md': '- deploy through the proxy\n' })
    const [revision] = await historyOf(id)
    expect(JSON.stringify(revision)).not.toContain(token)
    expect(revision?.before).toMatchObject({ redacted: true })
    const refused = await revert(change?.revision)
    expect(refused.status).toBe(409)
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe('- deploy through the proxy\n')
  })
})

describe('memory revert', () => {
  it('puts back the text, recreates a deleted file and removes a created one, as user revisions', async () => {
    const { id, dir } = await agent({ 'MEMORY.md': '- a\n', 'old.md': 'stale\n' })
    const recorded = await dream(id, dir, { 'MEMORY.md': '- b\n', 'old.md': null, 'new.md': 'new\n' })
    for (const change of recorded) {
      expect((await revert(change.revision)).status).toBe(200)
    }
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe('- a\n')
    expect(fs.readFileSync(path.join(dir, 'old.md'), 'utf8')).toBe('stale\n')
    expect(fs.existsSync(path.join(dir, 'new.md'))).toBe(false)
    const [latest] = await historyOf(id)
    expect([latest?.actor, latest?.reason]).toEqual(['user', `Reverted revision #${String(recorded.at(-1)?.revision)}`])
    const audit = await send<AuditPage>('GET', '/audit?kind=dream.reverted&limit=1')
    expect(audit.data.events[0]).toMatchObject({ actor: 'user', subject_id: id, detail: { path: 'old.md' } })
  })

  it('refuses a file changed since the revision, and leaves it alone', async () => {
    const { id, dir } = await agent({ 'MEMORY.md': '- a\n' })
    const [change] = await dream(id, dir, { 'MEMORY.md': '- b\n' })
    write(dir, { 'MEMORY.md': '- b\n- written later\n' })
    const res = await revert(change?.revision)
    expect(res.status).toBe(409)
    expect(res.data).toContain('changed after this revision')
    expect(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8')).toBe('- b\n- written later\n')
  })

  it('refuses a path that now passes through a link', async () => {
    const { id, dir } = await agent({ 'topics/a.md': 'one\n' })
    const [change] = await dream(id, dir, { 'topics/a.md': 'two\n' })
    const outside = path.join(scratch, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'a.md'), 'two\n')
    fs.rmSync(path.join(dir, 'topics'), { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'topics'))
    expect((await revert(change?.revision)).status).toBe(409)
    expect(fs.readFileSync(path.join(outside, 'a.md'), 'utf8')).toBe('two\n')
  })

  it('refuses the memory of an archived agent', async () => {
    const { id, dir } = await agent({ 'MEMORY.md': '- a\n' })
    const [change] = await dream(id, dir, { 'MEMORY.md': '- b\n' })
    await taskArchives.archive(id, 'user')
    expect((await revert(change?.revision)).status).toBe(409)
  })

  it('validates the agent query', async () => {
    expect((await send('GET', '/revisions?object_type=memory_file&task_id=not-a-task')).status).toBe(400)
    expect((await send('GET', `/revisions?object_type=context_pack&task_id=${randomUUID()}`)).status).toBe(400)
  })
})
