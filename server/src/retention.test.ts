import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { messages, repos, sql, tasks } from './db.js'
import { hasLocalChanges } from './git.js'
import { disposeIdleTasks } from './retention.js'
import { auditEvents } from './store/audit.js'

const open = vi.hoisted(() => new Set<string>())

vi.mock('./runner.js', () => ({
  sessionState: (id: string) => ({ open: open.has(id), background: 0 }),
  publish: () => undefined,
  runTurn: () => false,
}))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-retention-test-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function checkout(name: string): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir)
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  execFileSync('git', ['init', '-q', dir])
  return dir
}

async function task(
  id: string,
  updatedAt: string,
  fields: { repo_id?: string; cwd?: string; worktree?: boolean } = {},
): Promise<void> {
  await tasks.insert({
    id,
    title: `Task ${id}`,
    repo_id: fields.repo_id ?? null,
    cwd: fields.cwd ?? '/tmp',
    worktree: fields.worktree ?? false,
    pr_urls: [],
  })
  await messages.insert(id, { kind: 'prompt', payload: { text: 'hello' } }, [])
  await sql`UPDATE task SET updated_at = ${updatedAt} WHERE id = ${id}`
}

describe('disposeIdleTasks', () => {
  it('deletes tasks idle past the cutoff with their transcripts, and keeps busy and unsaved ones', async () => {
    const dirty = checkout('dirty')
    fs.writeFileSync(path.join(dirty, 'draft.txt'), 'unsaved')
    await repos.insert({ id: 'repo-1', slug: 'e2e/app', path: dirty, base_branch: 'main', created_at: '2026-01-01' })
    await task('stale', '2026-01-01T00:00:00.000Z')
    await task('fresh', '2026-09-20T00:00:00.000Z')
    await task('open', '2026-01-01T00:00:00.000Z')
    await task('pinned', '2026-01-01T00:00:00.000Z')
    await tasks.setPinned('pinned', true)
    await task('unsaved', '2026-01-01T00:00:00.000Z', { repo_id: 'repo-1', cwd: dirty, worktree: true })
    open.add('open')
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)

    const disposed = await disposeIdleTasks(90, new Date('2026-09-27T00:00:00.000Z'))

    expect(disposed).toEqual(['stale'])
    expect(await tasks.get('stale')).toBeUndefined()
    expect((await messages.page('stale', 10)).messages).toEqual([])
    const kept = await Promise.all(['fresh', 'open', 'unsaved', 'pinned'].map(async (id) => (await tasks.get(id))?.id))
    expect(kept).toEqual(['fresh', 'open', 'unsaved', 'pinned'])
    expect(stdout).toHaveBeenCalledWith('retention: kept task unsaved, its worktree has uncommitted changes\n')
    expect(await auditEvents.latest('task.deleted')).toMatchObject({
      actor: 'system',
      subject_id: 'stale',
      detail: { reason: 'retention', retention_days: 90 },
    })
    stdout.mockRestore()
  })
})

describe('hasLocalChanges', () => {
  it('tells clean checkouts from ones with changes, and says no when git cannot tell', async () => {
    const clean = checkout('clean')
    expect(await hasLocalChanges(clean)).toBe(false)
    fs.writeFileSync(path.join(clean, 'new.txt'), 'x')
    expect(await hasLocalChanges(clean)).toBe(true)
    expect(await hasLocalChanges(path.join(root, 'missing'))).toBe(false)
  })
})
