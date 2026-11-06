import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuditEvent, AuditPage, Repo, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { capabilityCache } from './capabilities.js'
import { CLAUDE_HOME, SCRATCH_ROOT, SETI_HOME, WORKTREE_ROOT } from './config.js'
import { repos, tasks } from './db.js'
import type { FakeSession } from './fake-sdk.js'
import { projectSlug } from './sandbox-mounts.js'
import { moveSessionTo } from './session-files.js'
import { sessionOptions, setupKey } from './session-options.js'
import { titleSlug } from './task-location.js'
import { taskReposContext } from './tasks.js'
import { USER_AUTH } from './test-auth.js'
import { waitIdle } from './wait-idle.js'
import { workspaceDir } from './workspace/dir.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-task-location-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  process.env.SETI_SCRATCH_ROOT = nodePath.join(root, 'work')
  return root
})

const sdk = await vi.hoisted(async () => {
  const fakes = await import('./fake-sdk.js')
  let sessions = 0
  const fake = new fakes.FakeSdk(async function* ({ text }) {
    await Promise.resolve()
    sessions += 1
    const init = {
      subtype: 'init',
      session_id: `session-${String(sessions)}`,
      model: 'haiku',
      permissionMode: 'default',
    }
    yield fakes.fakeMessage('system', init)
    yield fakes.fakeAssistant(`answer to: ${text}`)
    yield fakes.fakeResult()
  })
  return { fake, query: fake.query }
})

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  query: sdk.query,
}))

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

async function scratchRepo(name: string): Promise<Repo> {
  const origin = path.join(scratch, `${name}.git`)
  const checkout = path.join(scratch, name)
  fs.mkdirSync(checkout)
  git(scratch, 'init', '--bare', '--initial-branch=main', origin)
  git(checkout, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(checkout, `${name}.txt`), `${name}\n`)
  git(checkout, 'add', '.')
  git(checkout, 'commit', '-m', 'chore: seed')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', 'origin', 'main')
  git(checkout, 'checkout', '-b', 'dev')
  git(checkout, 'commit', '--allow-empty', '-m', 'chore: dev only')
  git(checkout, 'push', 'origin', 'dev')
  git(checkout, 'checkout', 'main')
  const repo: Repo = {
    id: crypto.randomUUID(),
    slug: `acme/${name}`,
    path: checkout,
    base_branch: 'main',
    created_at: '',
  }
  await repos.insert(repo)
  return repo
}

const app = createApp()
const prewarm = vi.spyOn(capabilityCache, 'prewarm')
const api = await scratchRepo('api')
const web = await scratchRepo('web')

interface Reply<T> {
  status: number
  body: { data: T; error?: { detail: string } }
}

type Method = 'POST' | 'PATCH' | 'DELETE' | 'GET'

async function send<T = Task>(method: Method, url: string, body?: unknown): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Reply<T>['body'] }
}

async function settledTask(body: Record<string, unknown>): Promise<Task> {
  const { status, body: reply } = await send('POST', '/tasks', { prompt: 'Look around', ...body })
  expect(status).toBe(200)
  await waitIdle(reply.data.id)
  return reply.data
}

async function nextTurn(taskId: string): Promise<FakeSession> {
  expect((await send('POST', `/tasks/${taskId}/messages`, { prompt: 'Carry on' })).status).toBe(200)
  await waitIdle(taskId)
  const last = sdk.fake.last
  if (!last) {
    throw new Error('No session started')
  }
  return last
}

async function latestAudit(kind: string): Promise<AuditEvent | undefined> {
  const page = await send<AuditPage>('GET', `/audit?kind=${kind}&limit=1`)
  return page.body.data.events[0]
}

const required = async (id: string) => {
  const task = await tasks.get(id)
  if (!task) {
    throw new Error('Task is gone')
  }
  return task
}

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('agents without a repo', () => {
  it('get a fresh working directory of their own under the work folder', async () => {
    const task = await settledTask({ title: 'Plan the Q4 offsite!' })
    expect(task.cwd).toBe(path.join(SCRATCH_ROOT, `plan-the-q4-offsite-${task.id.slice(0, 8)}`))
    expect(task).toMatchObject({ repo_id: null, repos: [], dirs: [], worktree: false })
    expect(fs.statSync(task.cwd).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(task.cwd, '.git'))).toBe(false)
    expect(sdk.fake.last?.options.cwd).toBe(task.cwd)
    expect(prewarm).toHaveBeenCalledWith(task.cwd)
    expect((await latestAudit('task.created'))?.detail).toMatchObject({ cwd: task.cwd, repos: [] })
  })

  it('still refuse a directory that does not exist, or an empty one', async () => {
    const empty = await send('POST', '/tasks', { title: 'Lost its repo', prompt: 'x', cwd: '' })
    expect(empty.status).toBe(400)
    const res = await send('POST', '/tasks', { title: 'Nowhere', prompt: 'x', cwd: '/nonexistent/seti-test' })
    expect(res).toMatchObject({
      status: 400,
      body: { error: { detail: 'Pick a repo or a working directory that exists' } },
    })
  })

  it('name their folder from the title, with a fallback for titles without letters', () => {
    expect(titleSlug('  Fix: the (API) docs  ')).toBe('fix-the-api-docs')
    expect(titleSlug('!!!')).toBe('agent')
    expect(titleSlug('a'.repeat(60))).toHaveLength(40)
  })
})

describe('adding and removing repos', () => {
  it('adds a checkout, which the next turn sees and the system prompt lists', async () => {
    const task = await settledTask({ title: 'Grows a repo' })
    const before = await setupKey(await required(task.id))
    const added = await send('POST', `/tasks/${task.id}/repos`, { repo_id: api.id })
    expect(added.status).toBe(200)
    expect(added.body.data.repos).toEqual([{ id: api.id, slug: 'acme/api', dir: api.path, worktree: false }])
    expect(await setupKey(await required(task.id))).not.toBe(before)

    const session = await nextTurn(task.id)
    expect(session.options).toMatchObject({ cwd: task.cwd, additionalDirectories: [api.path, workspaceDir(task.id)] })
    const context = await taskReposContext(task.id)
    expect(context).toContain(`- ${task.cwd} (your working directory)`)
    expect(context).toContain(`- acme/api: ${api.path}`)
    expect((await latestAudit('task.repo_added'))?.summary).toBe('Added acme/api to task "Grows a repo"')

    const again = await send('POST', `/tasks/${task.id}/repos`, { repo_id: api.id })
    expect(again).toMatchObject({ status: 409, body: { error: { detail: 'acme/api is already part of this agent' } } })
    const unknown = await send('POST', `/tasks/${task.id}/repos`, { repo_id: crypto.randomUUID() })
    expect(unknown).toMatchObject({ status: 400, body: { error: { detail: 'Unknown repo' } } })

    const removed = await send('DELETE', `/tasks/${task.id}/repos/${api.id}`)
    expect(removed.body.data.repos).toEqual([])
    expect(fs.existsSync(api.path)).toBe(true)
    expect((await latestAudit('task.repo_removed'))?.summary).toBe('Removed acme/api from task "Grows a repo"')
    expect((await nextTurn(task.id)).options.additionalDirectories).toEqual([workspaceDir(task.id)])
    expect(await taskReposContext(task.id)).toBeNull()
    expect((await send('DELETE', `/tasks/${task.id}/repos/${api.id}`)).status).toBe(404)
  })

  it('makes a worktree at the ref, keeps it when removed and deletes it with the task', async () => {
    const task = await settledTask({ title: 'Worktree later' })
    const added = await send('POST', `/tasks/${task.id}/repos`, { repo_id: api.id, worktree: true, ref: 'dev' })
    const [entry] = added.body.data.repos
    const dir = entry?.dir ?? ''
    expect(entry).toMatchObject({ id: api.id, worktree: true })
    expect(dir).toBe(path.join(WORKTREE_ROOT, `api-${task.id.slice(0, 8)}`))
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(git(api.path, 'rev-parse', 'origin/dev'))
    expect(added.body.data.worktree).toBe(true)
    expect(await taskReposContext(task.id)).toContain('Seti made a detached worktree of acme/api')

    await send('DELETE', `/tasks/${task.id}/repos/${api.id}`)
    expect(fs.existsSync(dir)).toBe(true)
    const back = await send('POST', `/tasks/${task.id}/repos`, { repo_id: api.id, worktree: true })
    expect(back.body.data.repos).toEqual([{ id: api.id, slug: 'acme/api', dir, worktree: true }])

    await send('DELETE', `/tasks/${task.id}/repos/${api.id}`)
    expect((await send('DELETE', `/tasks/${task.id}`)).status).toBe(204)
    expect(fs.existsSync(dir)).toBe(false)
    expect(git(api.path, 'worktree', 'list')).not.toContain(dir)
  })

  it('refuses to remove the repo the agent runs in', async () => {
    const task = await settledTask({ title: 'Runs in web', repo_id: web.id })
    const res = await send('DELETE', `/tasks/${task.id}/repos/${web.id}`)
    expect(res.status).toBe(409)
    expect(res.body.error?.detail).toContain('is the working directory')
  })
})

describe('adding and removing directories', () => {
  const notes = path.join(scratch, 'notes')
  fs.mkdirSync(notes, { recursive: true })

  it('adds an existing directory for the next turn and removes it without touching it', async () => {
    const task = await settledTask({ title: 'Reads notes' })
    const added = await send('POST', `/tasks/${task.id}/dirs`, { path: `${notes}/` })
    expect(added.body.data.dirs).toEqual([notes])
    expect((await nextTurn(task.id)).options).toMatchObject({ additionalDirectories: [notes, workspaceDir(task.id)] })
    expect(await taskReposContext(task.id)).toContain(`- ${notes}`)
    expect((await latestAudit('task.dir_added'))?.detail).toMatchObject({ dir: notes })
    expect((await send('POST', `/tasks/${task.id}/dirs`, { path: notes })).status).toBe(409)
    expect((await send('POST', `/tasks/${task.id}/dirs`, { path: task.cwd })).status).toBe(409)

    const removed = await send('DELETE', `/tasks/${task.id}/dirs?path=${encodeURIComponent(notes)}`)
    expect(removed.body.data.dirs).toEqual([])
    expect(fs.existsSync(notes)).toBe(true)
    expect((await latestAudit('task.dir_removed'))?.detail).toMatchObject({ dir: notes })
    expect((await send('DELETE', `/tasks/${task.id}/dirs?path=${encodeURIComponent(notes)}`)).status).toBe(404)
    const cwd = await send('DELETE', `/tasks/${task.id}/dirs?path=${encodeURIComponent(task.cwd)}`)
    expect(cwd.status).toBe(409)
  })

  it('always gives the agent its workspace as a working directory, once and never as cwd', async () => {
    const task = await settledTask({ title: 'Keeps notes' })
    const workspace = workspaceDir(task.id)
    expect((await nextTurn(task.id)).options.additionalDirectories).toEqual([workspace])
    const listed = await sessionOptions({ ...task, sandbox: false, dirs: [workspace, notes] }, new AbortController())
    expect(listed.additionalDirectories).toEqual([workspace, notes])
    const inside = await sessionOptions(
      { ...task, sandbox: false, cwd: workspace, dirs: [notes] },
      new AbortController(),
    )
    expect(inside.additionalDirectories).toEqual([notes])
  })

  it('refuses paths the sandbox could not mount', async () => {
    const task = await settledTask({ title: 'Picky' })
    const hidden = path.join(scratch, '.secret-stuff')
    const setiData = path.join(SETI_HOME, 'backups')
    fs.mkdirSync(hidden, { recursive: true })
    fs.mkdirSync(setiData, { recursive: true })
    const cases: [string, string][] = [
      ['relative/path', 'Give an absolute path or one under ~/'],
      [path.join(scratch, 'missing'), `${path.join(scratch, 'missing')} is not an existing directory`],
      [hidden, `${hidden} is a hidden path`],
      ['~', `${os.homedir()} holds your home directory`],
      ['/', '/ holds your home directory'],
      [setiData, `${setiData} is part of Seti's own data`],
    ]
    for (const [dir, message] of cases) {
      const res = await send('POST', `/tasks/${task.id}/dirs`, { path: dir })
      expect({ dir, status: res.status, detail: res.body.error?.detail }).toEqual({ dir, status: 400, detail: message })
    }
    expect((await required(task.id)).dirs).toEqual([])
  })
})

describe('changing the working directory', () => {
  it('moves the agent into an added repo, keeps the old folder and resumes the same session', async () => {
    const task = await settledTask({ title: 'Needs a repo now' })
    const sessionId = (await required(task.id)).session_id ?? ''
    expect(sessionId).not.toBe('')
    const oldProject = path.join(CLAUDE_HOME, 'projects', projectSlug(task.cwd))
    fs.mkdirSync(path.join(oldProject, sessionId, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(oldProject, `${sessionId}.jsonl`), '{}\n')

    expect((await send('PATCH', `/tasks/${task.id}`, { cwd: web.path })).status).toBe(400)
    await send('POST', `/tasks/${task.id}/repos`, { repo_id: web.id })
    const before = await setupKey(await required(task.id))
    prewarm.mockClear()
    const moved = await send('PATCH', `/tasks/${task.id}`, { cwd: web.path })
    expect(moved.status).toBe(200)
    expect(prewarm.mock.calls).toEqual([[web.path]])
    expect(moved.body.data).toMatchObject({
      cwd: web.path,
      repo_id: web.id,
      repo_slug: 'acme/web',
      repos: [{ id: web.id, dir: web.path, worktree: false }],
      dirs: [task.cwd],
    })
    expect(await setupKey(await required(task.id))).not.toBe(before)
    expect((await latestAudit('task.cwd_changed'))?.detail).toMatchObject({ cwd: web.path, previous_cwd: task.cwd })

    const session = await nextTurn(task.id)
    expect(session.options).toMatchObject({
      cwd: web.path,
      resume: sessionId,
      additionalDirectories: [task.cwd, workspaceDir(task.id)],
    })
    const newProject = path.join(CLAUDE_HOME, 'projects', projectSlug(web.path))
    expect(fs.existsSync(path.join(newProject, `${sessionId}.jsonl`))).toBe(true)
    expect(fs.existsSync(path.join(newProject, sessionId, 'subagents'))).toBe(true)
    expect(fs.existsSync(path.join(oldProject, `${sessionId}.jsonl`))).toBe(false)

    const back = await send('PATCH', `/tasks/${task.id}`, { cwd: task.cwd })
    expect(back.body.data).toMatchObject({ cwd: task.cwd, repo_id: null, dirs: [], repos: [{ id: web.id }] })
  })
})

describe('moving a session transcript', () => {
  it('leaves a transcript alone when it already sits under the working directory', () => {
    const home = fs.mkdtempSync(path.join(scratch, 'claude-home-'))
    const project = path.join(home, 'projects', projectSlug('/work/a'))
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 's1.jsonl'), 'kept\n')
    moveSessionTo(home, 's1', '/work/a')
    moveSessionTo(home, 'missing', '/work/b')
    expect(fs.readFileSync(path.join(project, 's1.jsonl'), 'utf8')).toBe('kept\n')
    expect(fs.existsSync(path.join(home, 'projects', projectSlug('/work/b')))).toBe(false)
  })
})
