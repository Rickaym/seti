import os from 'node:os'
import { pushRuleOwner, type Task } from '@seti/shared'
import { agentGitReading } from './git.js'
import { gh, viewerLogin } from './github.js'
import { agentGitView, type AgentGitView } from './outward-folder.js'
import { outwardCalls, type Outward, type OutwardAction } from './policy/outward.js'
import { rewriteUrl } from './push-url.js'
import { cache } from './redis.js'
import { permissionRules } from './store/permissions.js'

const GIT_TIMEOUT_MS = 5000

/** A push, fork or other write the user is asked about first, as the request reads on a phone. */
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
  'pr comment': 'Comment on',
  'pr review': 'Review',
  'pr merge': 'Merge into',
  'pr close': 'Close a pull request on',
  'pr reopen': 'Reopen a pull request on',
  'pr ready': 'Mark a pull request ready on',
  'pr edit': 'Edit a pull request on',
  'pr lock': 'Lock a pull request on',
  'pr unlock': 'Unlock a pull request on',
  'pr update-branch': 'Update a pull request on',
  'pr revert': 'Revert a pull request on',
  'issue create': 'Open an issue on',
  'issue comment': 'Comment on',
  'issue close': 'Close an issue on',
  'issue reopen': 'Reopen an issue on',
  'issue edit': 'Edit an issue on',
  'issue delete': 'Delete an issue on',
  'issue lock': 'Lock an issue on',
  'issue unlock': 'Unlock an issue on',
  'issue pin': 'Pin an issue on',
  'issue unpin': 'Unpin an issue on',
  'issue transfer': 'Move an issue on',
  'issue develop': 'Link a branch on',
  'release create': 'Publish a release on',
  'release edit': 'Edit a release on',
  'release delete': 'Delete a release on',
  'release upload': 'Upload to a release on',
  'release delete-asset': 'Delete a release asset on',
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
  if (/^(\/|\.|~|file:)/.test(text)) {
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

/** Git in the agent's folder as its own git sees it: hostile config read, nothing run. */
type Git = (...args: string[]) => Promise<string>

/** A key as git reads it: from the repository first, else from the agent's global config. */
async function setting(git: Git, repoOnly: Git, key: string): Promise<string> {
  const own = await repoOnly('config', '--get', key).catch(() => '')
  return own === '' ? git('config', '--get', key).catch(() => '') : own
}

/** The remote git pushes to by default from the folder's branch, as git itself picks it. */
async function defaultRemote(git: Git, repoOnly: Git): Promise<string> {
  const branch = await repoOnly('symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')
  const keys = [
    ...(branch === '' ? [] : [`branch.${branch}.pushRemote`]),
    'remote.pushDefault',
    ...(branch === '' ? [] : [`branch.${branch}.remote`]),
  ]
  for (const key of keys) {
    const name = await setting(git, repoOnly, key)
    if (name !== '') {
      return name
    }
  }
  return 'origin'
}

/** Whether a push from the folder also pushes its submodules, to remotes Seti does not read. */
async function pushesSubmodules(git: Git, repoOnly: Git): Promise<boolean> {
  const push = (await setting(git, repoOnly, 'push.recurseSubmodules')).toLowerCase()
  const recurse = (await setting(git, repoOnly, 'submodule.recurse')).toLowerCase()
  return push === 'on-demand' || (push === '' && ['true', 'yes', 'on', '1'].includes(recurse))
}

/** The URLs a remote of the folder names, rewrites applied; '*' takes every remote's. */
async function remoteUrls(git: Git, repoOnly: Git, remote: string | null): Promise<string[]> {
  const names = remote === '*' ? (await git('remote')).split('\n') : [remote ?? (await defaultRemote(git, repoOnly))]
  const urls = await Promise.all(
    names
      .filter((name) => name.trim() !== '')
      .flatMap((name) => [
        git('remote', 'get-url', '--push', '--all', '--', name),
        ...(remote === '*' ? [git('remote', 'get-url', '--all', '--', name)] : []),
      ]),
  )
  return [...new Set(urls.flatMap((out) => out.split('\n')).filter((line) => line.trim() !== ''))]
}

/** Whether git failed because the folder is in no repository, where gh cannot pick one either. */
const noRepository = (error: unknown) =>
  error instanceof Error && 'stderr' in error && /not a git repository/i.test(String(error.stderr))

/**
 * The places a push from a folder reaches, or [null] where git cannot say or it reaches more. A
 * gh call in a folder outside any repository reaches none, since gh fails there without writing.
 */
async function pushedFrom(view: AgentGitView, dir: string, where: { remote?: string | null; url?: string }) {
  const at = view.folder(dir)
  const git: Git = async (...args) => agentGitReading(GIT_TIMEOUT_MS, at, view.globals, ...args)
  const repoOnly: Git = async (...args) => agentGitReading(GIT_TIMEOUT_MS, at, [], ...args)
  try {
    if (await pushesSubmodules(git, repoOnly)) {
      return [null]
    }
    const urls =
      where.url === undefined
        ? await remoteUrls(git, repoOnly, where.remote ?? null)
        : [rewriteUrl(where.url, await git('config', '--get-regexp', '^url\\.').catch(() => ''))]
    return urls.length === 0 ? [null] : urls
  } catch (error) {
    return where.remote === '*' && noRepository(error) ? [] : [null]
  }
}

/** The repositories a call reaches: each with its owner, a bare owner, or null where unknown. */
async function reached(call: Outward, view: AgentGitView): Promise<(string | null)[]> {
  const { where } = call
  if ('unknown' in where) {
    return [null]
  }
  if ('owner' in where) {
    return [`${where.owner}/`]
  }
  return 'repo' in where ? [where.repo] : pushedFrom(view, where.dir, where)
}

/** Owners the user's own `PushTo(owner)` allow rules name, global and the agent's. */
async function allowedOwners(taskId: string): Promise<Set<string>> {
  const rules = [...(await permissionRules.list(null)), ...(await permissionRules.list(taskId))]
  const owners = rules.flatMap((rule) => {
    const named = rule.behavior === 'allow' ? pushRuleOwner(rule.rule) : null
    return named === null ? [] : [named.toLowerCase()]
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
  return { action, target: onGithub ? name : `${repo.host}/${name}`, owner: onGithub ? repo.owner : null }
}

/**
 * The pushes, forks, pull requests and other writes of a shell line that reach a repository
 * outside the user's own organisations, or that Seti cannot place; the user's `PushTo` rules
 * let a GitHub owner through. Read on the host with git's hostile-repository guards, never in
 * the sandbox.
 */
export async function outsidePushes(task: Task, command: string, cwd: string | null): Promise<OutsidePush[]> {
  const calls = outwardCalls(command, cwd, os.homedir())
  if (calls.length === 0) {
    return []
  }
  const [own, allowed, view] = await Promise.all([ownOwners(task), allowedOwners(task.id), agentGitView(task)])
  const found = await Promise.all(
    calls.map(async (call) => (await reached(call, view)).map((given) => outside(call.action, given, own))),
  )
  return found
    .flat()
    .filter((push): push is OutsidePush => push !== null)
    .filter((push) => push.owner === null || !allowed.has(push.owner.toLowerCase()))
}
