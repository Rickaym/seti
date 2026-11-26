import os from 'node:os'
import type { PermissionRequest, RequestPr, Task } from '@seti/shared'
import { tasks } from './db.js'
import { agentGitReading } from './git.js'
import { agentGitView } from './outward-folder.js'
import { repoOf } from './outward-push.js'
import { prMentions, type PrMention } from './policy/pr-mentions.js'
import { prDetails } from './pr-details.js'
import { permissionRequests } from './store/permissions.js'

/** PRs one request names at most; a card shows three of them. */
const MAX_PRS = 20
const GIT_TIMEOUT_MS = 5000
/** How long a request's PRs wait for their title and CI before they stay without them. */
const LOOKUP_WAIT_MS = 15_000

const prUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${String(number)}`

/** `owner/repo` of a github.com remote URL or gh's `owner/repo`; null for any other. */
function githubRepo(given: string): string | null {
  const repo = repoOf(given)
  return repo?.host === 'github.com' && repo.repo !== '' ? `${repo.owner}/${repo.repo}` : null
}

/**
 * The github.com repository gh acts on in a folder: the remote `gh repo set-default` chose, else
 * the one GitHub repository its remotes name; null where that is not one repository.
 */
async function folderRepo(task: Task, dir: string): Promise<string | null> {
  const view = await agentGitView(task)
  const git = async (...args: string[]) => agentGitReading(GIT_TIMEOUT_MS, view.folder(dir), view.globals, ...args)
  const url = async (remote: string) => git('remote', 'get-url', '--', remote).catch(() => '')
  try {
    const chosen = /^remote\.(.+)\.gh-resolved (.+)$/m.exec(await git('config', '--get-regexp', 'gh-resolved$'))
    if (chosen !== null) {
      return githubRepo(chosen[2] === 'base' ? await url(chosen[1] ?? '') : (chosen[2] ?? ''))
    }
  } catch {
    // No remote was chosen; the folder's remotes decide.
  }
  const remotes = (await git('remote').catch(() => '')).split('\n').filter((name) => name.trim() !== '')
  const named = (await Promise.all(remotes.map(url))).flatMap((given) => githubRepo(given) ?? [])
  const repos = new Map(named.map((repo) => [repo.toLowerCase(), repo]))
  return repos.size === 1 ? ([...repos.values()][0] ?? null) : null
}

/** The PRs the mentions name, each once, with folders read for their repository. */
async function resolve(task: Task, mentions: readonly PrMention[]): Promise<RequestPr[]> {
  const folders = new Map<string, Promise<string | null>>()
  const repoOfFolder = async (dir: string) => {
    const known = folders.get(dir) ?? folderRepo(task, dir).catch(() => null)
    folders.set(dir, known)
    return known
  }
  const found = await Promise.all(
    mentions.map(async (mention) => ({
      repo: 'dir' in mention ? await repoOfFolder(mention.dir) : `${mention.owner}/${mention.repo}`,
      number: mention.number,
    })),
  )
  const prs = new Map<string, RequestPr>()
  for (const { repo, number } of found) {
    const url = repo === null ? null : prUrl(repo, number)
    if (repo !== null && url !== null && !prs.has(url.toLowerCase())) {
      prs.set(url.toLowerCase(), { url, repo, number, title: null, ci: null })
    }
  }
  return [...prs.values()].slice(0, MAX_PRS)
}

/** The PRs with the title and CI Seti tracks, else read once through the cached lookup. */
async function withDetails(prs: readonly RequestPr[]): Promise<RequestPr[]> {
  const { details } = await prDetails(
    prs.map((pr) => pr.url),
    LOOKUP_WAIT_MS,
  )
  return prs.map((pr) => {
    const detail = details.get(pr.url) ?? null
    return detail === null ? pr : { ...pr, title: detail.title, ci: detail.ci }
  })
}

/** The command of a shell call, for the PRs it names. */
export const shellCommand = (tool: string, input: Record<string, unknown>): string | undefined =>
  tool === 'Bash' && typeof input.command === 'string' ? input.command : undefined

/** Where a request's command runs, for the PRs it names; `cwd` undefined means the agent's folder. */
export interface PrSource {
  command: string
  cwd?: string | null
}

/**
 * Adds the PRs a waiting request's command names, after it is shown: first each PR's repository
 * and number with its link, then its title and CI once read. `show` tells the request's views.
 */
export async function addRequestPrs(
  request: PermissionRequest,
  source: PrSource,
  show: (request: PermissionRequest) => Promise<void>,
): Promise<void> {
  const task = await tasks.get(request.task_id)
  const cwd = source.cwd === undefined ? (task?.cwd ?? null) : source.cwd
  const mentions = prMentions(source.command, cwd, os.homedir())
  if (task === undefined || mentions.length === 0) {
    return
  }
  const prs = await resolve(task, mentions)
  const named = prs.length === 0 ? undefined : await permissionRequests.setPrs(request.id, prs)
  if (named === undefined) {
    return
  }
  await show(named)
  const detailed = await withDetails(prs)
  if (detailed.every((pr) => pr.title === null && pr.ci === null)) {
    return
  }
  const filled = await permissionRequests.setPrs(request.id, detailed)
  if (filled !== undefined) {
    await show(filled)
  }
}
