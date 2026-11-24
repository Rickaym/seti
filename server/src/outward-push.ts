import type { Task } from '@seti/shared'
import { agentGitWithin } from './git.js'
import { gh, viewerLogin } from './github.js'
import { outwardCalls, type Outward, type OutwardAction } from './policy/outward.js'
import { cache } from './redis.js'
import { permissionRules } from './store/permissions.js'

const GIT_TIMEOUT_MS = 5000

/** A push, fork or write the user is asked about first, as the request reads on a phone. */
export interface OutsidePush {
  action: OutwardAction
  /** `owner/repo`, an owner, or null where Seti could not tell. */
  target: string | null
  /** The owner an allow rule `PushTo(owner)` would let through, or null. */
  owner: string | null
}

const VERBS: Record<OutwardAction, string> = {
  push: 'Push to',
  fork: 'Fork',
  pr: 'Open a pull request on',
  api: 'Write to',
}

/** The request's line: "Push to acme/tool, outside your organisations", or why Seti asks. */
export const outsideText = (push: OutsidePush): string =>
  push.target === null
    ? `${VERBS[push.action]} a repository Seti cannot tell is yours`
    : `${VERBS[push.action]} ${push.target}, outside your organisations`

/** The organisations of the signed-in gh account, read once an hour; none when gh cannot say. */
async function organisations(): Promise<string[]> {
  try {
    const listed = await cache.remember('gh:orgs', 60 * 60, async () =>
      gh(['api', 'user/orgs', '--paginate', '--jq', '.[].login']),
    )
    return listed.split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

/** Owners the agent pushes to without asking: the gh login, its organisations, the agent's repos. */
async function ownOwners(task: Task): Promise<Set<string>> {
  const login = await viewerLogin().catch(() => null)
  const repos = task.repos.map((repo) => repo.slug.split('/')[0] ?? '')
  const all = [...(login === null ? [] : [login]), ...(await organisations()), ...repos]
  return new Set(all.filter((owner) => owner !== '').map((owner) => owner.toLowerCase()))
}

const SCP_URL = /^(?:[\w.-]+@)?([\w.-]+):(?!\/)(.+)$/

/** `host/owner/repo` of a remote URL or `owner/repo`, or null for a local path. */
export function repoOf(given: string): { host: string; owner: string; repo: string } | null {
  const text = given
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  if (text.startsWith('/') || text.startsWith('.') || text.startsWith('file:')) {
    return null
  }
  const scp = SCP_URL.exec(text)
  let host = 'github.com'
  let rest = text
  if (/^[a-z+]+:\/\//.test(text)) {
    const url = new URL(text)
    host = url.hostname
    rest = url.pathname.replace(/^\//, '')
  } else if (scp !== null) {
    host = scp[1] ?? ''
    rest = scp[2] ?? ''
  }
  const [owner = '', repo = ''] = rest.split('/')
  return owner === '' ? null : { host: host.toLowerCase(), owner, repo }
}

/** The remote git pushes to by default from the folder's branch, as git itself picks it. */
async function defaultRemote(dir: string): Promise<string> {
  const read = async (...args: string[]) => agentGitWithin(GIT_TIMEOUT_MS, dir, ...args).catch(() => '')
  const branch = await read('symbolic-ref', '--short', '-q', 'HEAD')
  const tried = [
    branch === '' ? '' : await read('config', '--get', `branch.${branch}.pushRemote`),
    await read('config', '--get', 'remote.pushDefault'),
    branch === '' ? '' : await read('config', '--get', `branch.${branch}.remote`),
  ]
  return tried.find((name) => name !== '') ?? 'origin'
}

/** The push URLs of a remote of the folder's repository, rewrites applied; empty when unreadable. */
async function pushUrls(dir: string, remote: string | null): Promise<string[]> {
  try {
    const name = remote ?? (await defaultRemote(dir))
    const out = await agentGitWithin(GIT_TIMEOUT_MS, dir, 'remote', 'get-url', '--push', '--all', '--', name)
    return out.split('\n').filter((line) => line.trim() !== '')
  } catch {
    return []
  }
}

/** The repositories a call reaches: each with its owner, a bare owner, or null where unknown. */
async function reached(call: Outward): Promise<(string | null)[]> {
  const { where } = call
  if ('unknown' in where) {
    return [null]
  }
  if ('owner' in where) {
    return [`${where.owner}/`]
  }
  if ('repo' in where) {
    return [where.repo]
  }
  const urls = await pushUrls(where.dir, where.remote)
  return urls.length === 0 ? [null] : urls
}

/** Owners the user's own `PushTo(owner)` allow rules name, global and the agent's. */
async function allowedOwners(taskId: string): Promise<Set<string>> {
  const rules = [...(await permissionRules.list(null)), ...(await permissionRules.list(taskId))]
  const owners = rules.flatMap((rule) => {
    const named = rule.behavior === 'allow' ? /^PushTo\(([\w.-]+)\)$/.exec(rule.rule)?.[1] : undefined
    return named === undefined ? [] : [named.toLowerCase()]
  })
  return new Set(owners)
}

/** One reached repository the user is asked about, or null for one of their own. */
function outside(action: OutwardAction, given: string | null, own: Set<string>): OutsidePush | null {
  const repo = given === null ? undefined : repoOf(given)
  if (repo === null) {
    return null
  }
  if (repo === undefined) {
    return { action, target: null, owner: null }
  }
  const onGithub = repo.host === 'github.com'
  if (onGithub && own.has(repo.owner.toLowerCase())) {
    return null
  }
  const name = repo.repo === '' ? repo.owner : `${repo.owner}/${repo.repo}`
  return { action, target: onGithub ? name : `${repo.host}/${name}`, owner: repo.owner }
}

/**
 * The pushes, forks, pull requests and API writes of a shell line that reach a repository outside
 * the user's own organisations, or that Seti cannot place; the user's `PushTo` rules let an owner
 * through. Read in the agent's folder with git's hostile-repository guards, never in its sandbox.
 */
export async function outsidePushes(task: Task, command: string, cwd: string | null): Promise<OutsidePush[]> {
  const calls = outwardCalls(command, cwd)
  if (calls.length === 0) {
    return []
  }
  const [own, allowed] = await Promise.all([ownOwners(task), allowedOwners(task.id)])
  const found = await Promise.all(
    calls.map(async (call) => (await reached(call)).map((given) => outside(call.action, given, own))),
  )
  return found
    .flat()
    .filter((push): push is OutsidePush => push !== null)
    .filter((push) => push.owner === null || !allowed.has(push.owner.toLowerCase()))
}
