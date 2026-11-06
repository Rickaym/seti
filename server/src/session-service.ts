import path from 'node:path'
import type {
  ForkSessionOptions,
  ForkSessionResult,
  ListSessionsOptions,
  SDKSessionInfo,
  SessionMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeSession,
  ClaudeSessionDetail,
  ClaudeSessionPage,
  ImportSessionRequest,
  Repo,
  SessionImportResult,
  SessionListQuery,
  SuggestedPr,
  Task,
} from '@seti/shared'
import type { OpenPr } from './github.js'
import { HttpError } from './http.js'
import { sessionHistory, sessionPrs, sessionSpan } from './session-history.js'
import type { ImportedTaskInput } from './tasks.js'

interface SessionSdk {
  listSessions: (options: ListSessionsOptions) => Promise<SDKSessionInfo[]>
  getSessionInfo: (sessionId: string) => Promise<SDKSessionInfo | undefined>
  getSessionMessages: (sessionId: string) => Promise<SessionMessage[]>
  forkSession: (sessionId: string, options: ForkSessionOptions) => Promise<ForkSessionResult>
}

export interface SessionDeps {
  sdk: SessionSdk
  repos: () => Promise<Repo[]>
  worktrees: (repoPath: string) => Promise<string[]>
  openPrs: () => Promise<OpenPr[]>
  /** Session ids Seti already owns, as import sources or as the sessions its tasks resume. */
  knownSessions: () => Promise<Set<string>>
  exists: (dir: string) => boolean
  createTask: (input: ImportedTaskInput) => Promise<Task>
  /** Titles an import from the session's summary or first prompt, as the planner does. */
  title?: (text: string) => Promise<string>
  now?: () => number
}

interface RepoRoots {
  repo: Repo
  roots: string[]
}

const WORKTREE_TTL_MS = 60_000
const TITLE_MAX = 120

const inside = (dir: string, root: string) =>
  dir === root || dir.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/** The registered repo whose checkout or worktree holds `cwd`, preferring the deepest root. */
export function matchRepo(cwd: string | null, repos: readonly RepoRoots[]): Repo | null {
  if (cwd === null) {
    return null
  }
  let best: { repo: Repo; depth: number } | null = null
  for (const { repo, roots } of repos) {
    for (const root of roots) {
      if (inside(cwd, root) && (best === null || root.length > best.depth)) {
        best = { repo, depth: root.length }
      }
    }
  }
  return best?.repo ?? null
}

/** The most recently updated open PR of `repo` whose head branch is `branch`. */
export function suggestPr(repo: Repo | null, branch: string | null, prs: readonly OpenPr[]): SuggestedPr | null {
  if (repo === null || branch === null || branch === 'HEAD') {
    return null
  }
  const pr = prs.find((candidate) => candidate.repo_id === repo.id && candidate.head_ref === branch)
  return pr
    ? {
        url: pr.url,
        key: pr.key,
        number: pr.number,
        title: pr.title,
        ci: pr.ci,
        unresolved_threads: pr.unresolved_threads,
      }
    : null
}

/** Every PR the session created, then the open PR of its branch when it did not create that one. */
export const defaultPrs = (created: readonly string[], suggested: SuggestedPr | null): string[] => [
  ...new Set(suggested ? [...created, suggested.url] : created),
]

export function sessionTitle(info: SDKSessionInfo): string {
  const text = [info.customTitle, info.summary, info.firstPrompt, info.sessionId]
    .map((candidate) => candidate?.replace(/\s+/g, ' ').trim() ?? '')
    .find((candidate) => candidate !== '')
  const title = text ?? info.sessionId
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 3).trimEnd()}...` : title
}

const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString())

function matchesQuery(info: SDKSessionInfo, needle: string): boolean {
  if (needle === '') {
    return true
  }
  const haystack = [sessionTitle(info), info.cwd, info.gitBranch, info.sessionId, info.tag]
  return haystack.some((field) => field?.toLowerCase().includes(needle) === true)
}

export function createSessionService(deps: SessionDeps) {
  const clock = deps.now ?? Date.now
  const worktreeCache = new Map<string, { at: number; roots: string[] }>()
  const importing = new Set<string>()

  async function rootsOf(repo: Repo): Promise<string[]> {
    const cached = worktreeCache.get(repo.path)
    if (cached && clock() - cached.at < WORKTREE_TTL_MS) {
      return cached.roots
    }
    const roots = [...new Set([repo.path, ...(await deps.worktrees(repo.path))])]
    worktreeCache.set(repo.path, { at: clock(), roots })
    return roots
  }

  async function repoRoots(): Promise<RepoRoots[]> {
    return Promise.all((await deps.repos()).map(async (repo) => ({ repo, roots: await rootsOf(repo) })))
  }

  function toRow(info: SDKSessionInfo, roots: readonly RepoRoots[], prs: readonly OpenPr[]): ClaudeSession {
    const cwd = info.cwd ?? null
    const branch = info.gitBranch ?? null
    const repo = matchRepo(cwd, roots)
    return {
      id: info.sessionId,
      title: sessionTitle(info),
      cwd,
      git_branch: branch,
      created_at: iso(info.createdAt),
      last_modified: new Date(info.lastModified).toISOString(),
      size: info.fileSize ?? null,
      cwd_exists: cwd !== null && deps.exists(cwd),
      repo_id: repo?.id ?? null,
      repo_slug: repo?.slug ?? null,
      suggested_pr: suggestPr(repo, branch, prs),
    }
  }

  /** Rows for these sessions; the PR cache is read once and only when a row can use it. */
  async function toRows(infos: readonly SDKSessionInfo[]): Promise<ClaudeSession[]> {
    const roots = await repoRoots()
    const needsPrs = infos.some((info) => info.gitBranch !== undefined && matchRepo(info.cwd ?? null, roots) !== null)
    const prs = needsPrs ? await deps.openPrs() : []
    return infos.map((info) => toRow(info, roots, prs))
  }

  async function requireInfo(sessionId: string): Promise<SDKSessionInfo> {
    const info = await deps.sdk.getSessionInfo(sessionId)
    if (!info) {
      throw new HttpError(404, 'Session not found')
    }
    return info
  }

  async function list(query: SessionListQuery): Promise<ClaudeSessionPage> {
    const known = await deps.knownSessions()
    const needle = query.q?.toLowerCase() ?? ''
    const matching = (await deps.sdk.listSessions({ includeProgrammatic: false }))
      .filter((info) => !known.has(info.sessionId) && matchesQuery(info, needle))
      .sort((a, b) => b.lastModified - a.lastModified)
    const page = matching.slice(query.offset, query.offset + query.limit)
    return { sessions: await toRows(page), total: matching.length }
  }

  async function detail(sessionId: string): Promise<ClaudeSessionDetail> {
    const info = await requireInfo(sessionId)
    const raw = await deps.sdk.getSessionMessages(sessionId)
    const prs = sessionPrs(raw, sessionHistory(raw))
    const [row] = await toRows([info])
    if (!row) {
      throw new HttpError(404, 'Session not found')
    }
    const span = sessionSpan(raw)
    return {
      ...row,
      message_count: raw.length,
      first_at: span.first ?? row.created_at,
      last_at: span.last ?? row.last_modified,
      created_prs: prs.created,
      mentioned_prs: prs.mentioned,
      default_pr_urls: defaultPrs(prs.created, row.suggested_pr),
    }
  }

  async function target(info: SDKSessionInfo, repoId: string | undefined, roots: readonly RepoRoots[]) {
    if (repoId !== undefined) {
      const repo = (await deps.repos()).find((r) => r.id === repoId)
      if (!repo) {
        throw new HttpError(400, 'Unknown repo')
      }
      return { repo, cwd: repo.path }
    }
    const cwd = info.cwd ?? null
    if (cwd === null || !deps.exists(cwd)) {
      throw new HttpError(400, 'The session directory no longer exists here; pick a repo to import it into')
    }
    return { repo: matchRepo(cwd, roots), cwd }
  }

  /** Claude Code's own title or summary stays; a session with only a prompt gets a planned one. */
  async function importTitle(info: SDKSessionInfo): Promise<string> {
    const named = [info.customTitle, info.summary].some((candidate) => (candidate?.trim() ?? '') !== '')
    const prompt = info.firstPrompt?.trim() ?? ''
    return named || prompt === '' || deps.title === undefined ? sessionTitle(info) : deps.title(prompt)
  }

  async function importFresh(info: SDKSessionInfo, input: ImportSessionRequest): Promise<Task> {
    const roots = await repoRoots()
    const { repo, cwd } = await target(info, input.repo_id, roots)
    const raw = await deps.sdk.getSessionMessages(info.sessionId)
    const history = sessionHistory(raw)
    const title = input.title ?? (await importTitle(info))
    let prUrls = input.pr_urls
    if (prUrls === undefined) {
      const branch = info.gitBranch ?? null
      const suggested = repo && branch !== null ? suggestPr(repo, branch, await deps.openPrs()) : null
      prUrls = defaultPrs(sessionPrs(raw, history).created, suggested)
    }
    const fork = await deps.sdk.forkSession(info.sessionId, { title })
    return deps.createTask({
      title,
      repo_id: repo?.id ?? null,
      cwd,
      pr_urls: prUrls,
      session_id: fork.sessionId,
      source_session_id: info.sessionId,
      history,
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
    })
  }

  /** Forks the session so the terminal copy is never written by Seti, then creates its task. */
  async function importSession(sessionId: string, input: ImportSessionRequest): Promise<Task> {
    if (importing.has(sessionId)) {
      throw new HttpError(409, 'Session is already imported')
    }
    importing.add(sessionId)
    try {
      if ((await deps.knownSessions()).has(sessionId)) {
        throw new HttpError(409, 'Session is already imported')
      }
      return await importFresh(await requireInfo(sessionId), input)
    } finally {
      importing.delete(sessionId)
    }
  }

  async function importMany(
    items: readonly (ImportSessionRequest & { session_id: string })[],
  ): Promise<SessionImportResult[]> {
    const results: SessionImportResult[] = []
    for (const { session_id, ...input } of items) {
      try {
        const task = await importSession(session_id, input)
        results.push({ session_id, task_id: task.id, error: null })
      } catch (e) {
        results.push({ session_id, task_id: null, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return results
  }

  return { list, detail, importSession, importMany }
}
