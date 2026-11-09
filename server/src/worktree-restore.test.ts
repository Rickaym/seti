import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WORKTREE_ROOT } from './config.js'
import { repos, sql, tasks } from './db.js'
import { createWorktree, git } from './git.js'
import { auditEvents } from './store/audit.js'
import { restoreMissingWorktrees } from './worktree-restore.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-worktree-restore-'))

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const run = (cwd: string, ...args: string[]) =>
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like the server
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()

/** A clone of a repo with one commit on main, so origin/main exists. */
function clonedRepo(name: string): string {
  const upstream = path.join(root, `${name}-upstream`)
  fs.mkdirSync(upstream)
  run(upstream, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(upstream, 'README.md'), 'hello\n')
  run(upstream, 'add', '.')
  run(upstream, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first')
  const clone = path.join(root, name)
  run(root, 'clone', '-q', upstream, clone)
  return clone
}

/** An agent working in a worktree Seti made of the repo. */
async function agentInWorktree(id: string, repoPath: string): Promise<string> {
  await repos.insert({
    id: `repo-${id}`,
    slug: `e2e/${id}`,
    path: repoPath,
    base_branch: 'main',
    created_at: '2026-01-01',
  })
  const dir = await createWorktree(repoPath, 'main', `${id}-wt`)
  await tasks.insert({ id, title: `Agent ${id}`, repo_id: `repo-${id}`, cwd: dir, worktree: true, pr_urls: [] })
  return dir
}

async function agent(id: string) {
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error(`no task ${id}`)
  }
  return task
}

describe('restoreMissingWorktrees', () => {
  it('checks a removed worktree out again on its base branch, notes it and audits it', async () => {
    const repo = clonedRepo('lost')
    const dir = await agentInWorktree('lost', repo)
    await git(repo, 'worktree', 'remove', '--force', dir)
    const notes: string[] = []

    await restoreMissingWorktrees(await agent('lost'), async (text) => Promise.resolve(notes.push(text)))

    expect(fs.existsSync(dir)).toBe(true)
    expect(await git(dir, 'rev-parse', 'HEAD')).toBe(await git(repo, 'rev-parse', 'origin/main'))
    expect(notes).toEqual([
      `${dir} was missing, so Seti checked it out again at origin/main. Commits on a branch are still there; uncommitted changes from before are not.`,
    ])
    await auditEvents.settled()
    const { events } = await auditEvents.page({ kind: 'task.worktree_restored', limit: 5 })
    expect(events.find((event) => event.subject_id === 'lost')?.detail).toMatchObject({ dir, ref: 'origin/main' })
  })

  it('leaves a worktree that is still there alone', async () => {
    const repo = clonedRepo('kept')
    const dir = await agentInWorktree('kept', repo)
    fs.writeFileSync(path.join(dir, 'draft.txt'), 'unsaved')
    const notes: string[] = []

    await restoreMissingWorktrees(await agent('kept'), async (text) => Promise.resolve(notes.push(text)))

    expect(notes).toEqual([])
    expect(fs.readFileSync(path.join(dir, 'draft.txt'), 'utf8')).toBe('unsaved')
  })

  it('says which worktree it could not check out again', async () => {
    const repo = clonedRepo('gone')
    const dir = await agentInWorktree('gone', repo)
    await git(repo, 'worktree', 'remove', '--force', dir)
    await sql`UPDATE repo SET base_branch = 'no-such-branch' WHERE id = 'repo-gone'`

    await expect(restoreMissingWorktrees(await agent('gone'), async () => Promise.resolve())).rejects.toThrow(
      `The worktree ${dir} is missing and Seti could not check it out again`,
    )
    expect(dir.startsWith(WORKTREE_ROOT)).toBe(true)
  })
})
