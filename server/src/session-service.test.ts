import fs from 'node:fs'
import path from 'node:path'
import type { ForkSessionOptions, SDKSessionInfo, SessionMessage } from '@anthropic-ai/claude-agent-sdk'
import { auditQuery, type Repo } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { messages, repos, sql, tasks } from './db.js'
import type { OpenPr } from './github.js'
import {
  createSessionService,
  defaultPrs,
  matchRepo,
  sessionTitle,
  suggestPr,
  type SessionDeps,
} from './session-service.js'
import { auditEvents } from './store/audit.js'
import { sessionLinks } from './store/sessions.js'
import { createImportedTask } from './tasks.js'

const scratch = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const nodePath = await import('node:path')
  const root = mkdtempSync(nodePath.join(tmpdir(), 'seti-session-test-'))
  process.env.SETI_HOME = nodePath.join(root, 'seti')
  process.env.SETI_CLAUDE_HOME = nodePath.join(root, 'claude')
  return root
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

const checkout = path.join(scratch, 'app')
const worktree = path.join(scratch, 'worktrees', 'app-1')
fs.mkdirSync(path.join(checkout, 'web'), { recursive: true })
fs.mkdirSync(worktree, { recursive: true })

const REPO: Repo = {
  id: '00000000-0000-4000-8000-00000000000a',
  slug: 'acme/app',
  path: checkout,
  base_branch: 'main',
  created_at: '2026-01-01',
}
const OTHER: Repo = { ...REPO, id: '00000000-0000-4000-8000-00000000000b', slug: 'acme/other', path: '/srv/other' }
await repos.insert(REPO)

const CREATED = 'https://github.com/acme/app/pull/12'
const BRANCH_PR = 'https://github.com/acme/app/pull/7'

const ID = {
  web: '11111111-1111-4111-8111-111111111111',
  tree: '22222222-2222-4222-8222-222222222222',
  gone: '33333333-3333-4333-8333-333333333333',
  plain: '44444444-4444-4444-8444-444444444444',
  windows: '55555555-5555-4555-8555-555555555555',
}

const info = (sessionId: string, fields: Partial<SDKSessionInfo>): SDKSessionInfo => ({
  sessionId,
  summary: `Summary ${sessionId.slice(0, 4)}`,
  lastModified: Date.parse('2026-09-20T00:00:00Z'),
  ...fields,
})

const SESSIONS = [
  info(ID.web, {
    customTitle: 'Fix login',
    cwd: path.join(checkout, 'web'),
    gitBranch: 'feat/login',
    lastModified: Date.parse('2026-09-26T00:00:00Z'),
    createdAt: Date.parse('2026-09-25T00:00:00Z'),
    fileSize: 2048,
  }),
  info(ID.tree, { cwd: worktree, gitBranch: 'feat/other', lastModified: Date.parse('2026-09-24T00:00:00Z') }),
  info(ID.gone, { cwd: path.join(scratch, 'deleted'), lastModified: Date.parse('2026-09-25T00:00:00Z') }),
  info(ID.plain, {
    cwd: scratch,
    summary: 'Plain   notes\nabout nothing',
    lastModified: Date.parse('2026-09-23T00:00:00Z'),
  }),
  info(ID.windows, {
    cwd: String.raw`C:\Users\ada\app`,
    gitBranch: 'feat/login',
    lastModified: Date.parse('2026-09-22T00:00:00Z'),
  }),
]

let seq = 0
const entry = (type: 'user' | 'assistant', message: unknown, timestamp: string): SessionMessage =>
  ({
    type,
    uuid: `m-${String(++seq)}`,
    session_id: 'x',
    message,
    parent_tool_use_id: null,
    parent_agent_id: null,
    timestamp,
  }) as SessionMessage

const HISTORY = [
  entry('user', { role: 'user', content: 'Ship the login fix' }, '2026-09-25T08:00:00.000Z'),
  entry(
    'assistant',
    { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'gh pr create' } }] },
    '2026-09-25T08:01:00.000Z',
  ),
  entry(
    'user',
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: `${CREATED}\n` }] },
    '2026-09-25T08:02:00.000Z',
  ),
  entry(
    'assistant',
    { role: 'assistant', content: [{ type: 'text', text: 'Done, see https://github.com/acme/app/pull/1' }] },
    '2026-09-25T09:00:00.000Z',
  ),
]

function openPr(url: string, head: string, repo = REPO): OpenPr {
  const number = Number(url.split('/').at(-1))
  return {
    key: `app-${String(number)}`,
    repo_id: repo.id,
    repo_slug: repo.slug,
    number,
    title: `PR ${String(number)}`,
    url,
    draft: false,
    author: 'octocat',
    head_ref: head,
    base_ref: 'main',
    head_oid: 'abc',
    updated_at: '2026-09-26T00:00:00Z',
    review_decision: null,
    mergeable: 'unknown',
    labels: [],
    ci: 'success',
    checks: [],
    unresolved_threads: 0,
    preview: { state: 'none', url: null, commit: null, stale: false },
    preview_host: null,
    refs: [],
  }
}

const PRS = [openPr(BRANCH_PR, 'feat/login'), openPr('https://github.com/acme/other/pull/2', 'feat/other', OTHER)]

let forks = 0
const sdk = {
  listSessions: vi.fn<SessionDeps['sdk']['listSessions']>(),
  getSessionInfo: vi.fn<SessionDeps['sdk']['getSessionInfo']>(),
  getSessionMessages: vi.fn<SessionDeps['sdk']['getSessionMessages']>(),
  forkSession: vi.fn<(id: string, options: ForkSessionOptions) => Promise<{ sessionId: string }>>(),
}
const openPrs = vi.fn<() => Promise<OpenPr[]>>()
const worktrees = vi.fn<(repoPath: string) => Promise<string[]>>()

const makeService = (now?: () => number) =>
  createSessionService({
    sdk,
    repos: repos.list,
    worktrees,
    openPrs,
    knownSessions: sessionLinks.known,
    exists: fs.existsSync,
    createTask: createImportedTask,
    ...(now === undefined ? {} : { now }),
  })

const service = makeService()

beforeEach(() => {
  sdk.listSessions.mockReset().mockResolvedValue([...SESSIONS].reverse())
  sdk.getSessionInfo
    .mockReset()
    .mockImplementation(async (id) => Promise.resolve(SESSIONS.find((s) => s.sessionId === id)))
  sdk.getSessionMessages.mockReset().mockImplementation(async (id) => Promise.resolve(id === ID.plain ? [] : HISTORY))
  sdk.forkSession.mockReset().mockImplementation(async () => Promise.resolve({ sessionId: `fork-${String(++forks)}` }))
  openPrs.mockReset().mockResolvedValue(PRS)
  worktrees.mockReset().mockResolvedValue([checkout, worktree])
})

const ids = (page: { sessions: { id: string }[] }) => page.sessions.map((s) => s.id)

describe('matchRepo', () => {
  const roots = [
    { repo: REPO, roots: ['/srv/app', '/srv/wt/app-1'] },
    { repo: OTHER, roots: ['/srv/app/vendor/other'] },
  ]

  it('matches the checkout, its subdirectories and its worktrees, preferring the deepest root', () => {
    expect(matchRepo('/srv/app', roots)?.slug).toBe('acme/app')
    expect(matchRepo('/srv/app/web', roots)?.slug).toBe('acme/app')
    expect(matchRepo('/srv/wt/app-1/src', roots)?.slug).toBe('acme/app')
    expect(matchRepo('/srv/app/vendor/other/lib', roots)?.slug).toBe('acme/other')
  })

  it('does not match siblings that share a prefix, other paths or no cwd', () => {
    expect(matchRepo('/srv/app2', roots)).toBeNull()
    expect(matchRepo(String.raw`C:\srv\app`, roots)).toBeNull()
    expect(matchRepo(null, roots)).toBeNull()
  })
})

describe('suggestPr', () => {
  it('picks an open PR of the same repo whose head is the session branch', () => {
    expect(suggestPr(REPO, 'feat/login', PRS)).toEqual({
      url: BRANCH_PR,
      key: 'app-7',
      number: 7,
      title: 'PR 7',
      ci: 'success',
      unresolved_threads: 0,
    })
    expect(suggestPr(REPO, 'feat/other', PRS)).toBeNull()
    expect(suggestPr(REPO, 'HEAD', PRS)).toBeNull()
    expect(suggestPr(null, 'feat/login', PRS)).toBeNull()
  })
})

describe('defaultPrs', () => {
  const branch = { url: BRANCH_PR, key: 'app-7', number: 7, title: 'PR 7', ci: null, unresolved_threads: 0 }

  it('takes every PR the session created, then the open branch PR once', () => {
    expect(defaultPrs([BRANCH_PR, CREATED], branch)).toEqual([BRANCH_PR, CREATED])
    expect(defaultPrs(['https://github.com/acme/app/pull/1', CREATED], branch)).toEqual([
      'https://github.com/acme/app/pull/1',
      CREATED,
      BRANCH_PR,
    ])
    expect(defaultPrs([], branch)).toEqual([BRANCH_PR])
    expect(defaultPrs([], null)).toEqual([])
  })
})

describe('sessionTitle', () => {
  it('prefers the custom title, collapses whitespace and cuts long titles', () => {
    expect(sessionTitle(info(ID.web, { customTitle: 'Mine', summary: 'Auto' }))).toBe('Mine')
    expect(sessionTitle(info(ID.web, { summary: '  two\n lines ' }))).toBe('two lines')
    expect(sessionTitle(info(ID.web, { summary: 'x'.repeat(300) }))).toHaveLength(120)
  })
})

describe('listing sessions', () => {
  it('lists terminal sessions newest first with repo, PR and directory checks', async () => {
    const page = await service.list({ limit: 50, offset: 0 })
    expect(sdk.listSessions).toHaveBeenCalledWith({ includeProgrammatic: false })
    expect(ids(page)).toEqual([ID.web, ID.gone, ID.tree, ID.plain, ID.windows])
    expect(page.total).toBe(5)
    expect(page.sessions[0]).toEqual({
      id: ID.web,
      title: 'Fix login',
      cwd: path.join(checkout, 'web'),
      git_branch: 'feat/login',
      created_at: '2026-09-25T00:00:00.000Z',
      last_modified: '2026-09-26T00:00:00.000Z',
      size: 2048,
      cwd_exists: true,
      repo_id: REPO.id,
      repo_slug: 'acme/app',
      suggested_pr: { url: BRANCH_PR, key: 'app-7', number: 7, title: 'PR 7', ci: 'success', unresolved_threads: 0 },
    })
    const byId = new Map(page.sessions.map((s) => [s.id, s]))
    expect(byId.get(ID.tree)).toMatchObject({ repo_slug: 'acme/app', suggested_pr: null })
    expect(byId.get(ID.gone)).toMatchObject({ cwd_exists: false, repo_id: null })
    expect(byId.get(ID.windows)).toMatchObject({ cwd_exists: false, repo_id: null, suggested_pr: null })
    expect(openPrs).toHaveBeenCalledTimes(1)
  })

  it('searches title, directory and branch, and pages the matches', async () => {
    expect(ids(await service.list({ q: 'LOGIN', limit: 50, offset: 0 }))).toEqual([ID.web, ID.windows])
    expect(ids(await service.list({ q: 'worktrees/app-1', limit: 50, offset: 0 }))).toEqual([ID.tree])
    expect(ids(await service.list({ q: 'plain notes', limit: 50, offset: 0 }))).toEqual([ID.plain])
    const second = await service.list({ limit: 2, offset: 2 })
    expect(ids(second)).toEqual([ID.tree, ID.plain])
    expect(second.total).toBe(5)
  })

  it('skips the PR cache when no listed session belongs to a repo', async () => {
    await service.list({ q: 'plain', limit: 50, offset: 0 })
    expect(openPrs).not.toHaveBeenCalled()
  })

  it('caches worktree lookups for a minute', async () => {
    let clock = 0
    const timed = makeService(() => clock)
    await timed.list({ limit: 50, offset: 0 })
    await timed.list({ limit: 50, offset: 0 })
    expect(worktrees).toHaveBeenCalledTimes(1)
    clock += 61_000
    await timed.list({ limit: 50, offset: 0 })
    expect(worktrees).toHaveBeenCalledTimes(2)
  })
})

describe('session detail', () => {
  it('counts messages, spans the timestamps and finds created and mentioned PRs', async () => {
    const detail = await service.detail(ID.web)
    expect(detail).toMatchObject({
      id: ID.web,
      message_count: 4,
      first_at: '2026-09-25T08:00:00.000Z',
      last_at: '2026-09-25T09:00:00.000Z',
      created_prs: [CREATED],
      mentioned_prs: ['https://github.com/acme/app/pull/1'],
      default_pr_urls: [CREATED, BRANCH_PR],
    })
  })

  it('falls back to the suggested PR and the file times', async () => {
    const detail = await service.detail(ID.plain)
    expect(detail).toMatchObject({ message_count: 0, created_prs: [], default_pr_urls: [] })
    expect(detail.first_at).toBeNull()
    expect(detail.last_at).toBe('2026-09-23T00:00:00.000Z')
  })

  it('reports unknown sessions', async () => {
    await expect(service.detail('99999999-9999-4999-8999-999999999999')).rejects.toThrow('Session not found')
  })
})

const importedEvents = async () => auditEvents.page(auditQuery.parse({ kind: 'task.imported' }))

describe('importing a session', () => {
  it('forks the session and creates an idle task with its history, repo and created PR', async () => {
    const task = await service.importSession(ID.web, {})
    expect(sdk.forkSession).toHaveBeenCalledExactlyOnceWith(ID.web, { title: 'Fix login' })
    const forkId = (await sdk.forkSession.mock.results[0]?.value) as { sessionId: string }
    expect(task).toMatchObject({
      title: 'Fix login',
      repo_id: REPO.id,
      repo_slug: 'acme/app',
      cwd: path.join(checkout, 'web'),
      worktree: false,
      status: 'idle',
      session_id: forkId.sessionId,
      source_session_id: ID.web,
      pr_urls: [CREATED, BRANCH_PR],
    })
    const page = await messages.page(task.id, 50)
    expect(page.messages.map((row) => row.kind)).toEqual(['prompt', 'sdk', 'sdk', 'sdk'])
    expect(page.messages[0]).toMatchObject({
      payload: { text: 'Ship the login fix' },
      created_at: '2026-09-25T08:00:00.000Z',
    })

    const [event] = (await importedEvents()).events
    expect(event).toMatchObject({
      actor: 'user',
      subject_type: 'task',
      subject_id: task.id,
      summary: 'Imported session "Fix login" into acme/app',
      detail: {
        title: 'Fix login',
        cwd: path.join(checkout, 'web'),
        repo: 'acme/app',
        source_session_id: ID.web,
        session_id: forkId.sessionId,
        pr_urls: [CREATED, BRANCH_PR],
        messages: 4,
      },
    })
  })

  it('refuses a second import of the same source without forking again', async () => {
    await expect(service.importSession(ID.web, {})).rejects.toMatchObject({ status: 409 })
    expect(sdk.forkSession).not.toHaveBeenCalled()
  })

  it('refuses sessions that a Seti task already resumes', async () => {
    const own = (await tasks.list()).find((task) => task.source_session_id === ID.web)?.session_id ?? ''
    await expect(service.importSession(own, {})).rejects.toMatchObject({ status: 409 })
  })

  it('hides imported sources and Seti forks from the listing', async () => {
    const own = (await tasks.list()).find((task) => task.source_session_id === ID.web)?.session_id ?? ''
    sdk.listSessions.mockResolvedValue([...SESSIONS, info(own, { cwd: checkout })])
    expect(ids(await service.list({ limit: 50, offset: 0 }))).not.toContain(ID.web)
    expect(ids(await service.list({ limit: 50, offset: 0 }))).not.toContain(own)
  })

  it('rejects a session whose directory is gone unless a repo is picked', async () => {
    await expect(service.importSession(ID.gone, {})).rejects.toMatchObject({ status: 400 })
    await expect(service.importSession(ID.gone, { repo_id: OTHER.id })).rejects.toThrow('Unknown repo')
    expect(sdk.forkSession).not.toHaveBeenCalled()
  })

  it('imports a session from another machine into a chosen repo with its branch PR', async () => {
    sdk.getSessionMessages.mockResolvedValue([])
    const task = await service.importSession(ID.windows, { repo_id: REPO.id, title: 'From the laptop' })
    expect(sdk.forkSession).toHaveBeenCalledExactlyOnceWith(ID.windows, { title: 'From the laptop' })
    expect(task).toMatchObject({ cwd: checkout, repo_id: REPO.id, source_session_id: ID.windows, pr_urls: [BRANCH_PR] })
  })

  it('uses the given PRs, or none, over the ones found in the session', async () => {
    const none = await service.importSession(ID.tree, { pr_urls: [] })
    expect(none.pr_urls).toEqual([])
    const plain = await service.importSession(ID.plain, {})
    expect(plain).toMatchObject({ pr_urls: [], repo_id: null, cwd: scratch })
  })

  it('imports a batch and reports each failure on its own row', async () => {
    await sql`DELETE FROM task WHERE source_session_id = ${ID.tree}`
    const results = await service.importMany([
      { session_id: ID.tree, title: 'Tree work', pr_urls: [BRANCH_PR, CREATED] },
      { session_id: ID.gone },
      { session_id: ID.web },
    ])
    expect(results.map((r) => [r.session_id, r.error])).toEqual([
      [ID.tree, null],
      [ID.gone, 'The session directory no longer exists here; pick a repo to import it into'],
      [ID.web, 'Session is already imported'],
    ])
    expect(await tasks.get(results[0]?.task_id ?? '')).toMatchObject({
      title: 'Tree work',
      pr_urls: [BRANCH_PR, CREATED],
    })
  })
})
