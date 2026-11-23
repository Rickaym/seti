import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DreamProposal, DreamProposalInput, Task, TrashItem } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { findBinary } from '../binaries.js'
import { tasks } from '../db.js'
import { dreamRuns } from '../store/dreams.js'
import { EA_AUTH, USER_AUTH } from '../test-auth.js'
import { workspaceDir } from '../workspace/dir.js'
import { checkProposal } from './proposal-checks.js'
import { fileProposal } from './proposals.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-dream-proposals-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  return root
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const app = createApp()

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- names the response data type
async function send<T>(method: string, url: string, body?: unknown, auth: Record<string, string> = USER_AUTH) {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...auth, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; error?: { detail: string } }
  return { status: res.status, data: parsed.data, error: parsed.error?.detail ?? '' }
}

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync(findBinary('git'), ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim()

/** An agent whose folder holds a pushed checkout with ignored, untracked and branch fixtures. */
async function agent(): Promise<{ task: Task; cwd: string; repo: string }> {
  const id = randomUUID()
  const cwd = path.join(scratch, 'work', id)
  const repo = path.join(cwd, 'app')
  const origin = path.join(scratch, 'origins', `${id}.git`)
  fs.mkdirSync(repo, { recursive: true })
  fs.mkdirSync(origin, { recursive: true })
  gitIn(origin, 'init', '--bare', '-q', '-b', 'main')
  gitIn(repo, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules/\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-q', '-m', 'first')
  gitIn(repo, 'remote', 'add', 'origin', origin)
  gitIn(repo, 'push', '-q', '-u', 'origin', 'main')
  gitIn(repo, 'remote', 'set-head', 'origin', 'main')
  gitIn(repo, 'branch', 'done')
  gitIn(repo, 'switch', '-q', '-c', 'feature')
  fs.writeFileSync(path.join(repo, 'f.txt'), 'f\n')
  gitIn(repo, 'add', '.')
  gitIn(repo, 'commit', '-q', '-m', 'feature')
  gitIn(repo, 'switch', '-q', 'main')
  fs.writeFileSync(path.join(repo, '.env'), 'KEY=1\n')
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'node_modules', 'x', 'i.js'), '1')
  fs.writeFileSync(path.join(repo, 'loose.txt'), 'untracked\n')
  gitIn(repo, 'worktree', 'add', '-q', path.join(cwd, 'wt'), '-b', 'wtb')
  fs.writeFileSync(path.join(cwd, 'old-notes.md'), 'stale\n')
  fs.symlinkSync(path.join(cwd, 'old-notes.md'), path.join(cwd, 'link.md'))
  await tasks.insert({ id, title: 'Tidy', repo_id: null, cwd, worktree: false, pr_urls: [], sandbox: true })
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('not stored')
  }
  return { task, cwd, repo }
}

const check = async (task: Task, kind: DreamProposalInput['kind'], target: string) =>
  checkProposal({ kind, target, reason: 'stale' }, task, [task])

describe('clean-up proposals', () => {
  it('refuse anything that would lose work or is not the agent own, and allow clear leftovers', async () => {
    const { task, cwd, repo } = await agent()
    const refused = async (kind: DreamProposalInput['kind'], target: string) => {
      const answer = await check(task, kind, target)
      return typeof answer === 'string' ? answer : null
    }
    expect(await refused('trash', path.join(repo, 'README.md'))).toMatch(/tracks/)
    expect(await refused('trash', path.join(repo, 'loose.txt'))).toMatch(/untracked/)
    expect(await refused('trash', path.join(repo, '.env'))).toMatch(/not rebuildable/)
    expect(await refused('trash', path.join(cwd, 'link.md'))).toMatch(/symlink/)
    expect(await refused('trash', cwd)).toMatch(/not inside the agent's own folders/)
    expect(await refused('trash', '/etc/hostname')).toMatch(/not inside/)
    expect(await refused('trash', repo)).toMatch(/whole checkout/)
    fs.mkdirSync(workspaceDir(task.id), { recursive: true })
    fs.writeFileSync(path.join(workspaceDir(task.id), 'chat.md'), 'hi\n')
    expect(await refused('trash', path.join(workspaceDir(task.id), 'chat.md'))).toMatch(/Seti's/)
    expect(await refused('delete_branch', `${repo}:feature`)).toMatch(/not merged/)
    expect(await refused('delete_branch', `${repo}:main`)).toMatch(/checked out/)
    const other = { ...task, id: randomUUID(), cwd: path.join(cwd, 'wt') }
    expect(
      await checkProposal({ kind: 'trash', target: path.join(cwd, 'wt'), reason: 'x' }, task, [task, other]),
    ).toMatch(/another agent/)
    expect(await check(task, 'trash', path.join(cwd, 'old-notes.md'))).toMatchObject({ bytes: 6 })
    expect(await check(task, 'trash', path.join(repo, 'node_modules'))).toMatchObject({
      path: path.join(repo, 'node_modules'),
    })
    expect(await check(task, 'delete_branch', `${repo}:done`)).toMatchObject({ branch: 'done' })
    expect(await check(task, 'remove_worktree', path.join(cwd, 'wt'))).toMatchObject({ path: path.join(cwd, 'wt') })
    fs.writeFileSync(path.join(cwd, 'wt', 'new.txt'), 'x\n')
    expect(await refused('remove_worktree', path.join(cwd, 'wt'))).toMatch(/untracked/)
  })

  it('wait for the user own Allow, check again, move into the trash, restore and empty it', async () => {
    const { task, cwd, repo } = await agent()
    const run = await dreamRuns.start({ task_id: task.id, night: '2026-11-24', kind: 'nightly', model: 'm' })
    const notes = path.join(cwd, 'old-notes.md')
    expect(await fileProposal(task, run, { kind: 'trash', target: notes, reason: 'stale notes' })).toMatch(/^Filed/)
    expect(await fileProposal(task, run, { kind: 'delete_branch', target: `${repo}:done`, reason: 'merged' })).toMatch(
      /^Filed/,
    )
    expect(await fileProposal(task, run, { kind: 'trash', target: path.join(repo, '.env'), reason: 'x' })).toMatch(
      /^Not filed/,
    )
    const pending = (await send<DreamProposal[]>('GET', `/dreams/proposals?task=${task.id}`)).data ?? []
    expect(pending.map((p) => p.kind)).toEqual(['trash', 'delete_branch'])
    const [trash, branch] = pending
    const byEa = await send('POST', `/dreams/proposals/${String(trash?.id)}`, { decision: 'allow' }, EA_AUTH)
    expect([byEa.status, byEa.error]).toEqual([403, expect.stringMatching(/The EA cannot/)])
    expect(
      (await send<DreamProposal>('POST', `/dreams/proposals/${String(trash?.id)}`, { decision: 'allow' })).data,
    ).toMatchObject({ state: 'allowed' })
    expect(fs.existsSync(notes)).toBe(false)
    gitIn(repo, 'switch', '-q', 'done')
    const late = await send<DreamProposal>('POST', `/dreams/proposals/${String(branch?.id)}`, { decision: 'allow' })
    expect(late.data).toMatchObject({ state: 'failed', detail: expect.stringMatching(/checked out/) as unknown })
    const [item] = (await send<TrashItem[]>('GET', '/trash')).data ?? []
    expect(item).toMatchObject({ original_path: notes, bytes: 6 })
    expect((await send('POST', `/trash/${String(item?.id)}/restore`, undefined, EA_AUTH)).status).toBe(200)
    expect(fs.readFileSync(notes, 'utf8')).toBe('stale\n')
    expect((await send('DELETE', '/trash', undefined, EA_AUTH)).status).toBe(403)
    expect((await send<{ count: number }>('DELETE', '/trash')).data).toMatchObject({ count: 0 })
  })
})
