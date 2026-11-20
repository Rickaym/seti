import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { AuditEvent, AuditPage, Task } from '@seti/shared'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { capabilityCache } from './capabilities.js'
import { CLAUDE_HOME, SCRATCH_ROOT } from './config.js'
import { sql, tasks } from './db.js'
import type { FakeSession } from './fake-sdk.js'
import { projectSlug } from './sandbox-mounts.js'
import { moveSessionTo } from './session-files.js'
import { sessionOptions } from './session-options.js'
import { setupKey } from './session-spec.js'
import { SELF_TOOLS } from './seti-tools/self.js'
import { callSetiTool } from './seti-tools/server.js'
import { taskFolderContext, titleSlug } from './task-location.js'
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
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

const app = createApp()
const prewarm = vi.spyOn(capabilityCache, 'prewarm')

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

/** Calls the agent's own tool that moves its session, as the agent does. */
async function moveTo(taskId: string, target: string) {
  const [entry] = SELF_TOOLS.filter((tool) => tool.name === 'set_working_directory')
  if (entry === undefined) {
    throw new Error('No set_working_directory tool')
  }
  const result = await callSetiTool(entry, taskId, { path: target })
  return { text: result.content[0]?.text ?? '', isError: result.isError === true }
}

describe('starting an agent', () => {
  it('gives it a fresh working directory of its own under the work folder', async () => {
    const task = await settledTask({ title: 'Plan the Q4 offsite!' })
    expect(task.cwd).toBe(path.join(SCRATCH_ROOT, `plan-the-q4-offsite-${task.id.slice(0, 8)}`))
    expect(task).toMatchObject({ repo_id: null, repos: [], dirs: [], worktree: false, home_access: false })
    expect(fs.statSync(task.cwd).isDirectory()).toBe(true)
    expect(fs.existsSync(path.join(task.cwd, '.git'))).toBe(false)
    expect(sdk.fake.last?.options.cwd).toBe(task.cwd)
    expect(prewarm).toHaveBeenCalledWith(task.cwd)
    const created = await latestAudit('task.created')
    expect(created?.summary).toBe(`Created task "Plan the Q4 offsite!" in ${task.cwd}`)
    expect(created?.detail).toMatchObject({ cwd: task.cwd })
  })

  it('ignores the repo, branch and directory an older tab or script still sends', async () => {
    const old = {
      repo_id: crypto.randomUUID(),
      repo_ids: [crypto.randomUUID()],
      cwd: '/nonexistent/seti-test',
      worktree: true,
      ref: 'dev',
    }
    const task = await settledTask({ title: 'Old fields', ...old })
    expect(task.cwd).toBe(path.join(SCRATCH_ROOT, `old-fields-${task.id.slice(0, 8)}`))
    expect(task).toMatchObject({ repo_id: null, repos: [], dirs: [], worktree: false })

    const planned = await send('POST', '/tasks/start', { prompt: 'Look around', ...old, repo_id: undefined })
    expect(planned.status).toBe(200)
    await waitIdle(planned.body.data.id)
    expect(path.dirname(planned.body.data.cwd)).toBe(SCRATCH_ROOT)
    expect(planned.body.data.repos).toEqual([])
  })

  it('names the folder from the title, with a fallback for titles without letters', () => {
    expect(titleSlug('  Fix: the (API) docs  ')).toBe('fix-the-api-docs')
    expect(titleSlug('!!!')).toBe('agent')
    expect(titleSlug('a'.repeat(60))).toHaveLength(40)
  })

  it('tells the agent to clone into its folder and to move its session into the clone', async () => {
    const task = await settledTask({ title: 'Reads its prompt' })
    const context = await taskFolderContext(task.id)
    expect(context).toContain(`Your own working folder is ${task.cwd}.`)
    expect(context).toContain('git clone or gh repo clone')
    expect(context).toContain('make worktrees inside it')
    expect(context).toContain('seti set_working_directory')
    expect(JSON.stringify(sdk.fake.last?.options.systemPrompt)).toContain('Your own working folder is')
  })

  it('has no routes that add a repo or a directory, and no working directory to patch', async () => {
    const task = await settledTask({ title: 'Stays put' })
    expect((await send('POST', `/tasks/${task.id}/repos`, { repo_id: crypto.randomUUID() })).status).toBe(404)
    expect((await send('POST', `/tasks/${task.id}/dirs`, { path: scratch })).status).toBe(404)
    const patched = await send('PATCH', `/tasks/${task.id}`, { cwd: scratch })
    expect(patched.status).toBe(200)
    expect(patched.body.data).toMatchObject({ cwd: task.cwd, dirs: [] })
  })
})

describe('an agent moving its session into a clone', () => {
  it('works in the clone from the next turn, keeps its folder and resumes the same session', async () => {
    const task = await settledTask({ title: 'Clones a repo' })
    const clone = path.join(task.cwd, 'web')
    git(task.cwd, 'init', '--initial-branch=main', clone)
    const sessionId = (await required(task.id)).session_id ?? ''
    expect(sessionId).not.toBe('')
    const oldProject = path.join(CLAUDE_HOME, 'projects', projectSlug(task.cwd))
    fs.mkdirSync(path.join(oldProject, sessionId, 'subagents'), { recursive: true })
    fs.writeFileSync(path.join(oldProject, `${sessionId}.jsonl`), '{}\n')
    const before = await setupKey(await required(task.id))
    prewarm.mockClear()

    const moved = await moveTo(task.id, 'web')
    expect(moved.isError).toBe(false)
    expect(moved.text).toContain(`Your session runs in ${clone} from your next turn`)
    expect(prewarm.mock.calls).toEqual([[clone]])
    expect(await required(task.id)).toMatchObject({ cwd: clone, repo_id: null, repos: [], dirs: [task.cwd] })
    expect(await setupKey(await required(task.id))).not.toBe(before)
    const event = await latestAudit('task.cwd_changed')
    expect(event).toMatchObject({ actor: 'agent', detail: { cwd: clone, previous_cwd: task.cwd, agent_id: task.id } })

    const session = await nextTurn(task.id)
    expect(session.options).toMatchObject({
      cwd: clone,
      resume: sessionId,
      additionalDirectories: [task.cwd, workspaceDir(task.id)],
    })
    const newProject = path.join(CLAUDE_HOME, 'projects', projectSlug(clone))
    expect(fs.existsSync(path.join(newProject, `${sessionId}.jsonl`))).toBe(true)
    expect(fs.existsSync(path.join(newProject, sessionId, 'subagents'))).toBe(true)
    expect(fs.existsSync(path.join(oldProject, `${sessionId}.jsonl`))).toBe(false)
    const context = await taskFolderContext(task.id)
    expect(context).toContain(`Your own working folder is ${task.cwd}.`)
    expect(context).toContain(`Your session runs in ${clone}.`)

    const other = path.join(task.cwd, 'api')
    fs.mkdirSync(other)
    expect((await moveTo(task.id, other)).isError).toBe(false)
    expect(await required(task.id)).toMatchObject({ cwd: other, dirs: [task.cwd] })
    expect((await moveTo(task.id, task.cwd)).isError).toBe(false)
    expect(await required(task.id)).toMatchObject({ cwd: task.cwd, dirs: [] })
  })

  it('refuses a directory outside its own folders, through a link too, and one that is missing', async () => {
    const task = await settledTask({ title: 'Stays inside' })
    const outside = path.join(scratch, 'elsewhere')
    fs.mkdirSync(outside, { recursive: true })
    fs.symlinkSync(outside, path.join(task.cwd, 'link'))
    for (const target of [outside, '..', path.join(task.cwd, 'link'), '/']) {
      const refused = await moveTo(task.id, target)
      expect({ target, ...refused }).toMatchObject({ target, isError: true })
      expect(refused.text).toContain('stays inside your own folders')
    }
    const missing = await moveTo(task.id, 'not-cloned-yet')
    expect(missing.text).toContain('is not an existing directory')
    expect((await required(task.id)).cwd).toBe(task.cwd)
  })

  it('is a tool every agent has, at any Seti control level', async () => {
    const id = `cwd-off-${crypto.randomUUID().slice(0, 8)}`
    const own = path.join(SCRATCH_ROOT, id)
    fs.mkdirSync(path.join(own, 'repo'), { recursive: true })
    await tasks.insert({ id, title: id, repo_id: null, cwd: own, worktree: false, pr_urls: [], seti_control: 'off' })
    expect((await moveTo(id, 'repo')).isError).toBe(false)
    expect((await required(id)).cwd).toBe(path.join(own, 'repo'))
  })
})

describe('an agent from before agents cloned for themselves', () => {
  const notes = path.join(scratch, 'notes')
  fs.mkdirSync(notes, { recursive: true })

  it('keeps its extra directories in its session and its prompt', async () => {
    const task = await settledTask({ title: 'Reads notes' })
    await sql`INSERT INTO task_dir (task_id, dir) VALUES (${task.id}, ${notes})`
    expect((await required(task.id)).dirs).toEqual([notes])
    expect((await nextTurn(task.id)).options).toMatchObject({ additionalDirectories: [notes, workspaceDir(task.id)] })
    expect(await taskFolderContext(task.id)).toContain(`Your own working folder is ${task.cwd}.`)

    const id = `old-dir-${crypto.randomUUID().slice(0, 8)}`
    await tasks.insert({ id, title: id, repo_id: null, cwd: scratch, worktree: false, pr_urls: [] })
    expect(await taskFolderContext(id)).toBeNull()
    await sql`INSERT INTO task_dir (task_id, dir) VALUES (${id}, ${notes})`
    const context = await taskFolderContext(id)
    expect(context).toContain('This task spans several directories')
    expect(context).toContain(`- ${scratch} (your working directory)`)
    expect(context).toContain(`- ${notes}`)
    expect(context).not.toContain('Your own working folder')
    expect((await moveTo(id, notes)).isError).toBe(false)
    expect(await required(id)).toMatchObject({ cwd: notes, dirs: [scratch] })
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
