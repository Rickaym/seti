import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import type { PermissionRequest, RequestPr, Task } from '@seti/shared'
import { tasks } from './db.js'
import { agentGitReading } from './git.js'
import { prStates, type PrState } from './github-pr-states.js'
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

const MAX_CANDIDATE_REPOS = 10
/** Guessed chips per number a command names without a repository, when several repos have it. */
const MAX_GUESSES = 3

const newPr = (repo: string, number: number): RequestPr => ({
  url: prUrl(repo, number),
  repo,
  number,
  title: null,
  ci: null,
  state: null,
})

const LINKED = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+$/

/** The github.com repositories the agent works in: its own and those of the PRs linked to it. */
function agentRepos(task: Task): string[] {
  const linked = task.pr_urls.flatMap((url) => LINKED.exec(url)?.[1] ?? [])
  const all = [...task.repos.map((repo) => repo.slug), ...linked]
  return [...new Map(all.map((repo) => [repo.toLowerCase(), repo])).values()].slice(0, MAX_CANDIDATE_REPOS)
}

/** The PRs the mentions name and, for a number whose folder names no repository, guesses. */
interface Resolved {
  known: RequestPr[]
  /** The number in each of the agent's repositories, kept only where that PR exists. */
  guesses: RequestPr[]
}

/**
 * The PRs the mentions name, each once, with folders read for their repository. A number whose
 * folder gives none is guessed in the agent's own repositories: a hint for the reader only, never
 * used to decide anything, which the outward check reads apart and more strictly.
 */
async function resolve(task: Task, mentions: readonly PrMention[]): Promise<Resolved> {
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
  const known = new Map<string, RequestPr>()
  const guesses = new Map<string, RequestPr>()
  for (const { repo, number } of found) {
    if (repo !== null) {
      known.set(prUrl(repo, number).toLowerCase(), newPr(repo, number))
    } else {
      agentRepos(task).forEach((each) => guesses.set(prUrl(each, number).toLowerCase(), newPr(each, number)))
    }
  }
  const sure = [...known.values()].slice(0, MAX_PRS)
  const unsure = [...guesses.values()].filter((pr) => !known.has(pr.url.toLowerCase()))
  return { known: sure, guesses: unsure.slice(0, MAX_PRS) }
}

/** The guesses whose PR exists, open or merged, at most a few for each number. */
function confirmed(guesses: readonly RequestPr[]): RequestPr[] {
  const real = guesses.filter((pr) => pr.state === 'open' || pr.state === 'merged')
  return real.filter((pr) => real.filter((other) => other.number === pr.number).indexOf(pr) < MAX_GUESSES)
}

/**
 * The PRs with the title, CI and state Seti tracks for open ones, else read once through a cached
 * lookup that also answers for merged and closed ones.
 */
async function withDetails(prs: readonly RequestPr[]): Promise<RequestPr[]> {
  const { details } = await prDetails(
    prs.map((pr) => pr.url),
    LOOKUP_WAIT_MS,
  )
  const ended = prs.filter((pr) => (details.get(pr.url) ?? null) === null).map((pr) => pr.url)
  const none = new Map<string, PrState>()
  const states = ended.length === 0 ? none : await within(prStates(ended), none)
  return prs.map((pr) => {
    const open = details.get(pr.url) ?? null
    const read = states.get(pr.url)
    if (open !== null) {
      return { ...pr, title: open.title, ci: open.ci, state: 'open' }
    }
    return read === undefined ? pr : { ...pr, ...read }
  })
}

/** The work's answer, or `fallback` when it fails or takes longer than a lookup may. */
const within = async <T>(work: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([work.catch(() => fallback), sleep(LOOKUP_WAIT_MS, fallback, { ref: false })])

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
  const { known, guesses } = await resolve(task, mentions)
  if (known.length > 0) {
    const named = await permissionRequests.setPrs(request.id, known)
    if (named === undefined) {
      return
    }
    await show(named)
  }
  const looked = await withDetails([...known, ...guesses])
  const detailed = [...looked.slice(0, known.length), ...confirmed(looked.slice(known.length))]
  const learned = detailed.some((pr) => pr.title !== null || pr.ci !== null || pr.state !== null)
  if (!learned) {
    return
  }
  const filled = await permissionRequests.setPrs(request.id, detailed)
  if (filled !== undefined) {
    await show(filled)
  }
}
