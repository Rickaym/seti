import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { AutoArchiveStatus, StaleFolderDeleteResult, StaleFolderReport, Task } from '@seti/shared'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from './app.js'
import { bundleDir, bundleTaskFiles, removeTaskFolders } from './archive-files.js'
import { archiveTask, unarchiveTask, updateAutoArchive } from './archive.js'
import { ARCHIVE_ROOT, SCRATCH_ROOT, WORKTREE_ROOT } from './config.js'
import { repos, sql, tasks } from './db.js'
import { createWorktree } from './git.js'
import { busyReason, removalRefusal, scratchDirOf } from './owned-dirs.js'
import { sweepArchiveLifecycle } from './retention.js'
import { taskArchives } from './store/archive.js'
import { auditEvents } from './store/audit.js'
import { taskLocation } from './store/task-location.js'
import { deleteTask } from './task-actions.js'
import { createScratchDir } from './task-location.js'
import { USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'

const app = createApp()
const HEADERS = { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' }
const DAY = 24 * 60 * 60 * 1000
const OUTSIDE = fs.mkdtempSync(path.join(path.dirname(SCRATCH_ROOT), 'outside-'))

afterAll(() => {
  fs.rmSync(OUTSIDE, { recursive: true, force: true })
})

async function data<T>(response: Response): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200)
  return ((await response.json()) as { data: T }).data
}

const request = async (method: string, route: string, body?: unknown) =>
  app.request(`/api${route}`, {
    method,
    headers: HEADERS,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

function git(cwd: string, ...args: string[]): string {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  return execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim()
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

async function insertTask(title: string, cwd: string): Promise<Task> {
  const id = randomUUID()
  await tasks.insert({ id, title, repo_id: null, cwd, worktree: false, pr_urls: [] })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task not inserted')
  }
  return task
}

/** A task started without a repo: a scratch folder with work, dependencies and a build in it. */
async function scratchTask(title: string): Promise<{ task: Task; scratch: string }> {
  const id = randomUUID()
  const scratch = createScratchDir(id, title)
  write(path.join(scratch, 'notes.md'), '# notes\n')
  write(path.join(scratch, 'src', 'main.ts'), 'export const x = 1\n')
  write(path.join(scratch, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  write(path.join(scratch, 'pkg', 'dist', 'out.js'), 'built\n')
  write(path.join(scratch, '.venv', 'bin', 'python'), 'venv\n')
  await tasks.insert({ id, title, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
  write(path.join(workspaceDir(id), 'notes', 'mine.md'), 'workspace note\n')
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('task not inserted')
  }
  return { task, scratch }
}

async function archived(taskId: string) {
  await archiveTask(taskId, { actor: 'user', removeWorktree: true })
  return bundleTaskFiles(taskId)
}

/** A process working in `dir` until it is killed. */
async function workIn(dir: string) {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the sleep on PATH
  const child = spawn('sleep', ['60'], { cwd: dir, stdio: 'ignore' })
  await new Promise<void>((resolve) => {
    child.on('spawn', resolve)
  })
  return {
    stop: async () => {
      const exited = new Promise((resolve) => {
        child.on('exit', resolve)
      })
      child.kill()
      await exited
    },
  }
}

describe('folders Seti may remove', () => {
  it('names the scratch folder from the task id and never a folder the user picked', async () => {
    const { task, scratch } = await scratchTask('Own scratch')
    expect(scratchDirOf(task)).toBe(scratch)
    const picked = path.join(SCRATCH_ROOT, 'my-project')
    fs.mkdirSync(picked, { recursive: true })
    const user = await insertTask('User picked', picked)
    expect(scratchDirOf(user)).toBeNull()
    const borrowed = await insertTask('Borrowed', scratch)
    expect(scratchDirOf(borrowed)).toBeNull()
  })

  it('refuses symlinks, dot-dot paths, the root itself, nested folders and folders outside', () => {
    const inside = path.join(SCRATCH_ROOT, 'plain')
    fs.mkdirSync(path.join(inside, 'nested'), { recursive: true })
    const link = path.join(SCRATCH_ROOT, 'link')
    fs.symlinkSync(OUTSIDE, link)
    const linkedParent = path.join(SCRATCH_ROOT, 'linked-parent')
    fs.symlinkSync(OUTSIDE, linkedParent)
    fs.mkdirSync(path.join(OUTSIDE, 'child'), { recursive: true })

    expect(removalRefusal(inside, 'scratch', [])).toBeNull()
    expect(removalRefusal(link, 'scratch', [])).toMatch(/symlink/)
    expect(removalRefusal(`${SCRATCH_ROOT}/plain/../plain`, 'scratch', [])).toMatch(/plain absolute path/)
    expect(removalRefusal(`${SCRATCH_ROOT}/../${path.basename(OUTSIDE)}`, 'scratch', [])).toMatch(/plain absolute/)
    expect(removalRefusal(SCRATCH_ROOT, 'scratch', [])).toMatch(/not directly inside/)
    expect(removalRefusal(path.join(inside, 'nested'), 'scratch', [])).toMatch(/not directly inside/)
    expect(removalRefusal(path.join(linkedParent, 'child'), 'scratch', [])).toMatch(/not directly inside/)
    expect(removalRefusal(OUTSIDE, 'scratch', [])).toMatch(/not directly inside/)
    expect(removalRefusal('plain', 'scratch', [])).toMatch(/plain absolute path/)
    expect(removalRefusal(`${inside}/`, 'scratch', [])).toMatch(/plain absolute path/)
    expect(removalRefusal(path.join(SCRATCH_ROOT, 'missing'), 'scratch', [])).toMatch(/does not exist/)
    expect(removalRefusal(inside, 'worktrees', [])).toMatch(/not directly inside/)
  })

  it('refuses a folder another agent works in or inside of', async () => {
    const { task, scratch } = await scratchTask('Shared scratch')
    const sibling = await insertTask('Sibling', path.join(scratch, 'src'))
    expect(removalRefusal(scratch, 'scratch', [sibling])).toBe(`agent ${sibling.id} uses ${path.join(scratch, 'src')}`)
    expect(removalRefusal(scratch, 'scratch', [task])).toMatch(/uses/)
  })

  it('sees a process working in a folder and a git lock in it', async () => {
    const dir = path.join(SCRATCH_ROOT, 'busy')
    fs.mkdirSync(path.join(dir, 'deep'), { recursive: true })
    const worker = await workIn(path.join(dir, 'deep'))
    try {
      expect(await busyReason(dir)).toMatch(/^process \d+ works in /)
    } finally {
      await worker.stop()
    }
    expect(await busyReason(dir)).toBeNull()
    git(dir, 'init', '-q')
    fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '')
    expect(await busyReason(dir)).toMatch(/lock/)
  })
})

describe('archive bundle', () => {
  it('packs the scratch folder and workspace without dependencies or builds, and restores them', async () => {
    const { task, scratch } = await scratchTask('Pack me')

    const files = await archived(task.id)

    expect(files).toMatchObject({ state: 'bundled', reason: null, path: bundleDir(task.id) })
    expect(files?.bytes).toBeGreaterThan(0)
    expect(files?.folders.map((folder) => folder.dir)).toEqual([scratch, workspaceDir(task.id)])
    expect(fs.existsSync(scratch)).toBe(false)
    expect(fs.existsSync(workspaceDir(task.id))).toBe(false)
    expect(fs.readdirSync(bundleDir(task.id)).filter((name) => name.endsWith('.tar.zst'))).toHaveLength(1)
    const listed = await data<{ id: string; archive: { files: { bytes: number } } }[]>(
      await request('GET', '/tasks/archived'),
    )
    expect(listed.find((entry) => entry.id === task.id)?.archive.files.bytes).toBe(files?.bytes)

    const report = await unarchiveTask(task.id)

    expect(report.folders).toEqual([
      { dir: scratch, restored: true },
      { dir: workspaceDir(task.id), restored: true },
    ])
    expect(fs.readFileSync(path.join(scratch, 'src', 'main.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(fs.readFileSync(path.join(workspaceDir(task.id), 'notes', 'mine.md'), 'utf8')).toBe('workspace note\n')
    expect(fs.existsSync(path.join(scratch, 'node_modules'))).toBe(false)
    expect(fs.existsSync(path.join(scratch, '.venv'))).toBe(false)
    expect(fs.existsSync(path.join(scratch, 'pkg', 'dist'))).toBe(false)
    expect(fs.existsSync(bundleDir(task.id))).toBe(false)
  })

  it('waits while a process works in the folder and packs it on a later sweep', async () => {
    const { task, scratch } = await scratchTask('Busy scratch')
    const worker = await workIn(scratch)
    try {
      const files = await archived(task.id)
      expect(files).toMatchObject({ state: 'pending', reason: expect.stringMatching(/^process \d+/) as string })
      expect(fs.existsSync(path.join(scratch, 'notes.md'))).toBe(true)
    } finally {
      await worker.stop()
    }

    await sweepArchiveLifecycle()

    expect((await taskArchives.get(task.id))?.files).toMatchObject({ state: 'bundled', reason: null })
    expect(fs.existsSync(scratch)).toBe(false)
  })

  it('leaves a scratch folder another agent works in', async () => {
    const { task, scratch } = await scratchTask('Lent out')
    await insertTask('Borrower', scratch)

    const files = await archived(task.id)

    expect(files).toMatchObject({ state: 'pending', reason: expect.stringMatching(/^agent .* uses/) as string })
    expect(fs.existsSync(path.join(scratch, 'notes.md'))).toBe(true)
  })

  it('never packs or removes a directory the user picked', async () => {
    const picked = fs.mkdtempSync(path.join(SCRATCH_ROOT, 'picked-'))
    write(path.join(picked, 'keep.txt'), 'mine')
    const task = await insertTask('User directory', picked)

    expect(await archived(task.id)).toMatchObject({ state: 'none', folders: [] })
    await deleteTask(task)

    expect(fs.readFileSync(path.join(picked, 'keep.txt'), 'utf8')).toBe('mine')
  })

  it('removes the scratch folder, workspace and bundle when an agent is deleted', async () => {
    const live = await scratchTask('Delete live')
    const packed = await scratchTask('Delete archived')
    await archived(packed.task.id)
    expect(fs.existsSync(bundleDir(packed.task.id))).toBe(true)

    await deleteTask(live.task)
    await deleteTask(packed.task)

    expect(fs.existsSync(live.scratch)).toBe(false)
    expect(fs.existsSync(workspaceDir(live.task.id))).toBe(false)
    expect(fs.existsSync(bundleDir(packed.task.id))).toBe(false)
    expect(fs.existsSync(ARCHIVE_ROOT)).toBe(true)
  })

  it('keeps a deleted agent folder that another agent still uses', async () => {
    const { task, scratch } = await scratchTask('Delete shared')
    await taskLocation.addDir((await insertTask('Holder', OUTSIDE)).id, scratch)

    expect(await removeTaskFolders(task)).toEqual([expect.stringMatching(/^agent .* uses/)])
    expect(fs.existsSync(scratch)).toBe(true)
  })
})

describe('worktrees on archive', () => {
  const origin = path.join(OUTSIDE, 'origin.git')
  const checkout = path.join(OUTSIDE, 'checkout')

  async function worktreeTask(name: string) {
    if (!fs.existsSync(checkout)) {
      git(OUTSIDE, 'init', '-q', '--bare', '--initial-branch=main', origin)
      git(OUTSIDE, 'init', '-q', '--initial-branch=main', checkout)
      write(path.join(checkout, 'README.md'), '# app\n')
      git(checkout, 'add', '.')
      git(checkout, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'seed')
      git(checkout, 'remote', 'add', 'origin', origin)
      git(checkout, 'push', '-q', '-u', 'origin', 'main')
      await repos.insert({
        id: 'repo-files',
        slug: 'acme/files',
        path: checkout,
        base_branch: 'main',
        created_at: '2026',
      })
    }
    const dir = await createWorktree(checkout, 'main', name)
    const id = randomUUID()
    await tasks.insert({ id, title: name, repo_id: 'repo-files', cwd: dir, worktree: true, pr_urls: [] })
    return { id, dir }
  }

  it('removes a clean worktree on a local branch and keeps the branch', async () => {
    const { id, dir } = await worktreeTask('local-branch')
    git(dir, 'checkout', '-q', '-b', 'feat/local')
    write(path.join(dir, 'local.txt'), 'local')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=T', '-c', 'user.email=t@t.invalid', 'commit', '-q', '-m', 'local')

    const report = await archiveTask(id, { actor: 'user', removeWorktree: true })

    expect(report.worktrees[0]).toMatchObject({ removed: true, branch: 'feat/local' })
    expect(git(checkout, 'branch', '--list', 'feat/local')).toContain('feat/local')
  })

  it('keeps a dirty worktree and saves its changes as a patch in the bundle', async () => {
    const { id, dir } = await worktreeTask('dirty-files')
    write(path.join(dir, 'README.md'), '# changed\n')
    write(path.join(dir, 'new.txt'), 'untracked\n')

    const report = await archiveTask(id, { actor: 'user', removeWorktree: true })

    const kept = report.worktrees[0]
    expect(kept).toMatchObject({ removed: false, kept_because: 'it has uncommitted changes' })
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all').split('\n')).toEqual([
      'M README.md',
      '?? new.txt',
    ])
    const patch = kept?.patch ?? ''
    expect(path.dirname(path.dirname(patch))).toBe(bundleDir(id))
    const copy = path.join(OUTSIDE, 'copy')
    git(checkout, 'worktree', 'add', '-q', '--detach', copy, 'HEAD')
    git(copy, 'apply', patch)
    expect(fs.readFileSync(path.join(copy, 'new.txt'), 'utf8')).toBe('untracked\n')
    expect(fs.readFileSync(path.join(copy, 'README.md'), 'utf8')).toBe('# changed\n')
    expect((await bundleTaskFiles(id))?.bytes).toBeGreaterThan(0)
  })

  it('refuses to remove a worktree folder another agent uses', async () => {
    const { id, dir } = await worktreeTask('shared-worktree')
    await insertTask('Worktree guest', dir)

    const report = await archiveTask(id, { actor: 'user', removeWorktree: true })

    expect(report.worktrees[0]).toMatchObject({ removed: false })
    expect(report.worktrees[0]?.kept_because).toMatch(/^agent .* uses/)
    expect(fs.existsSync(dir)).toBe(true)
  })
})

describe('delete rule', () => {
  it('deletes archived agents past the rule with their bundle, and keeps pinned ones', async () => {
    const old = await scratchTask('Long archived')
    const pinned = await scratchTask('Pinned archived')
    const fresh = await scratchTask('Fresh archived')
    for (const { task } of [old, pinned, fresh]) {
      await archived(task.id)
    }
    await tasks.setPinned(pinned.task.id, true)
    const longAgo = new Date(Date.now() - 40 * DAY).toISOString()
    await sql`UPDATE task_archive SET archived_at = ${longAgo} WHERE task_id IN (${old.task.id}, ${pinned.task.id})`
    await updateAutoArchive({ enabled: false, days: 3, delete_after_days: 30 })

    const result = await sweepArchiveLifecycle()

    expect(result.deleted.map((entry) => entry.task_id)).toEqual([old.task.id])
    expect(await tasks.get(old.task.id)).toBeUndefined()
    expect(fs.existsSync(bundleDir(old.task.id))).toBe(false)
    expect(await tasks.get(pinned.task.id)).toBeDefined()
    expect(await tasks.get(fresh.task.id)).toBeDefined()
    await updateAutoArchive({ enabled: false, days: 3, delete_after_days: null })
  })

  it('is off by default, and a save that leaves it out keeps it', async () => {
    const before = await data<AutoArchiveStatus>(await request('GET', '/archive/settings'))
    expect(before.settings.delete_after_days).toBeNull()
    await data(await request('PUT', '/archive/settings', { enabled: true, days: 3, delete_after_days: 90 }))
    const kept = await data<AutoArchiveStatus>(await request('PUT', '/archive/settings', { enabled: true, days: 4 }))
    expect(kept.settings).toMatchObject({ days: 4, delete_after_days: 90 })
    expect((await auditEvents.latest('system.auto_archive_changed'))?.summary).toBe(
      'Set auto archive on, for COMPLETE agents idle 4 days or more; delete archived agents after 90 days',
    )
    const off = await request('PUT', '/archive/settings', { enabled: true, days: 3, delete_after_days: null })
    expect((await data<AutoArchiveStatus>(off)).settings.delete_after_days).toBeNull()
    const [applied] = await sql`SELECT name FROM schema_migration WHERE version = 59`
    expect(applied).toEqual({ name: 'archive_files' })
  })
})

describe('stale folders', () => {
  const aged = (dir: string) => {
    const when = new Date(Date.now() - 30 * DAY)
    fs.utimesSync(dir, when, when)
    for (const name of fs.readdirSync(dir)) {
      fs.utimesSync(path.join(dir, name), when, when)
    }
    return dir
  }

  it('lists old folders no agent owns with sizes, and deletes only those on confirm', async () => {
    const orphan = path.join(SCRATCH_ROOT, 'orphan-clone')
    write(path.join(orphan, 'big.bin'), 'x'.repeat(10_000))
    aged(orphan)
    const recent = path.join(SCRATCH_ROOT, 'recent-clone')
    write(path.join(recent, 'a.txt'), 'a')
    const { scratch: ownedScratch } = await scratchTask('Owned and old')
    aged(ownedScratch)
    const strayWorktree = path.join(WORKTREE_ROOT, 'stray-old')
    write(path.join(strayWorktree, 'file.txt'), 'stray')
    aged(strayWorktree)
    fs.symlinkSync(OUTSIDE, path.join(SCRATCH_ROOT, 'old-link'))

    const report = await data<StaleFolderReport>(await request('GET', '/archive/stale-folders?days=7'))

    const listed = report.folders.map((folder) => folder.path)
    expect(listed).toEqual(expect.arrayContaining([orphan, strayWorktree]))
    expect(listed).not.toContain(recent)
    expect(listed).not.toContain(ownedScratch)
    expect(listed).not.toContain(path.join(SCRATCH_ROOT, 'old-link'))
    expect(report.folders.find((folder) => folder.path === orphan)?.bytes).toBeGreaterThanOrEqual(10_000)

    const unconfirmed = await request('POST', '/archive/stale-folders/delete', { paths: [orphan] })
    expect(unconfirmed.status).toBe(400)
    expect(fs.existsSync(orphan)).toBe(true)

    const result = await data<StaleFolderDeleteResult>(
      await request('POST', '/archive/stale-folders/delete', {
        paths: [orphan, recent, ownedScratch, SCRATCH_ROOT, `${orphan}/..`, path.join(SCRATCH_ROOT, 'old-link')],
        confirm: true,
      }),
    )

    expect(result.deleted.map((entry) => entry.path)).toEqual([orphan])
    expect(result.refused.map((entry) => entry.path)).toEqual([
      recent,
      ownedScratch,
      SCRATCH_ROOT,
      `${orphan}/..`,
      path.join(SCRATCH_ROOT, 'old-link'),
    ])
    expect(fs.existsSync(orphan)).toBe(false)
    expect(fs.existsSync(recent) && fs.existsSync(ownedScratch) && fs.existsSync(OUTSIDE)).toBe(true)
  })
})
