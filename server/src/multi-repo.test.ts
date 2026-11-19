import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type * as Sdk from '@anthropic-ai/claude-agent-sdk'
import type { Repo, Task } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { WORKTREE_ROOT } from './config.js'
import { repos, tasks } from './db.js'
import { createWorktree } from './git.js'
import { tokenOwner } from './github-token.js'
import { taskFolderContext } from './task-location.js'
import { USER_AUTH } from './test-auth.js'
import { workspaceDir } from './workspace/dir.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-multi-repo-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

const sdk = vi.hoisted(() => ({ calls: [] as { prompt: unknown; options?: Options }[] }))

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof Sdk>()),
  query: (params: { prompt: unknown; options?: Options }) => {
    sdk.calls.push(params)
    const session = (async function* () {
      await Promise.resolve()
      yield* []
    })()
    return Object.assign(session, { close: () => undefined })
  },
}))

function git(cwd: string, ...args: string[]): string {
  const identity = ['-c', 'user.name=Seti Test', '-c', 'user.email=test@seti.invalid']
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- tests use the git on PATH like git.ts
  return execFileSync('git', [...identity, '-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim()
}

/** A checkout whose origin is a local bare repo with main and, when asked, a dev branch. */
async function scratchRepo(name: string, withDev = false): Promise<Repo> {
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
  if (withDev) {
    git(checkout, 'checkout', '-b', 'dev')
    git(checkout, 'commit', '--allow-empty', '-m', 'chore: dev only')
    git(checkout, 'push', 'origin', 'dev')
    git(checkout, 'checkout', 'main')
  }
  const repo: Repo = {
    id: crypto.randomUUID(),
    slug: `acme/${name}`,
    path: checkout,
    base_branch: 'main',
    created_at: '2026-01-01',
  }
  await repos.insert(repo)
  return repo
}

const app = createApp()
const api = await scratchRepo('api', true)
const web = await scratchRepo('web')

interface Reply<T> {
  status: number
  body: { data: T; error?: { detail: string } }
}

async function send<T>(method: 'POST' | 'PUT' | 'DELETE' | 'GET', url: string, body?: unknown): Promise<Reply<T>> {
  const res = await app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...USER_AUTH, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await res.text()
  return { status: res.status, body: (text === '' ? {} : JSON.parse(text)) as Reply<T>['body'] }
}

let count = 0

/** An agent as Seti made them before agents cloned for themselves: a worktree of each repo. */
async function worktreeAgent(list: readonly Repo[]): Promise<Task> {
  const id = `repo-agent-${String(++count)}-${crypto.randomUUID().slice(0, 8)}`
  const dirs: string[] = []
  for (const repo of list) {
    dirs.push(await createWorktree(repo.path, repo.base_branch, `${path.basename(repo.path)}-${id}`))
  }
  const [primary, ...extras] = list.map((repo, index) => ({ repo_id: repo.id, dir: dirs[index] ?? '' }))
  await tasks.insert(
    {
      id,
      title: 'Cross repo',
      repo_id: primary?.repo_id ?? null,
      cwd: primary?.dir ?? '',
      worktree: true,
      pr_urls: [],
      sandbox: false,
      home_access: true,
    },
    extras,
  )
  return required(id)
}

async function required(id: string): Promise<Task> {
  const task = await tasks.get(id)
  if (task === undefined) {
    throw new Error('Task is gone')
  }
  return task
}

const lastCall = () => sdk.calls.at(-1)?.options

/** Sessions start once the task's GitHub token is looked up, just after the turn is asked for. */
async function started(sessions: number): Promise<void> {
  await vi.waitFor(() => {
    expect(sdk.calls).toHaveLength(sessions)
  })
}

beforeEach(() => {
  sdk.calls.length = 0
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

describe('an agent that Seti gave worktrees of several repos', () => {
  it('keeps them in its session and prompt, and loses them when it is deleted', async () => {
    const task = await worktreeAgent([api, web])
    const [primary, extra] = task.repos
    const primaryDir = primary?.dir ?? ''
    const extraDir = extra?.dir ?? ''
    expect(task.repos.map((repo) => repo.slug)).toEqual(['acme/api', 'acme/web'])
    expect(task).toMatchObject({ repo_id: api.id, repo_slug: 'acme/api', cwd: primaryDir, worktree: true })
    expect(primaryDir.startsWith(WORKTREE_ROOT)).toBe(true)
    expect(extraDir.startsWith(WORKTREE_ROOT)).toBe(true)

    expect((await send('POST', `/tasks/${task.id}/messages`, { prompt: 'Carry on' })).status).toBe(200)
    await started(1)
    expect(lastCall()).toMatchObject({ cwd: primaryDir, additionalDirectories: [extraDir, workspaceDir(task.id)] })
    const append = JSON.stringify(lastCall()?.systemPrompt)
    expect(append).toContain(`- acme/api: ${primaryDir} (your working directory)`)
    expect(append).toContain(`- acme/web: ${extraDir}`)
    expect(append).toContain('Seti made a detached worktree of acme/api, acme/web')
    expect(append).not.toContain('Your own working folder')

    expect((await send('DELETE', `/tasks/${task.id}`)).status).toBe(204)
    expect(fs.existsSync(primaryDir)).toBe(false)
    expect(fs.existsSync(extraDir)).toBe(false)
    expect(git(api.path, 'worktree', 'list')).not.toContain(primaryDir)
    expect(git(web.path, 'worktree', 'list')).not.toContain(extraDir)
  })

  it('says nothing about folders to an agent with one repo', async () => {
    const task = await worktreeAgent([api])
    expect(await taskFolderContext(task.id)).toBeNull()
    await send('DELETE', `/tasks/${task.id}`)
  })
})

describe('the GitHub token for requests that name no owner', () => {
  it("is the first repo owner's for an older agent and the credential's default for a new one", async () => {
    const old = await worktreeAgent([api, web])
    expect(tokenOwner(old)).toBe('acme')
    const { body } = await send<Task>('POST', '/tasks', { title: 'No repo', prompt: 'Look around', sandbox: false })
    expect(body.data.repos).toEqual([])
    expect(tokenOwner(body.data)).toBeNull()
    await started(1)
    await send('DELETE', `/tasks/${old.id}`)
  })
})
