import path from 'node:path'
import { ghWrites } from './outward-gh.js'
import { current, ghRepo, optionValue, positional, type Outward } from './outward-where.js'
import { denyForms, rawWords } from './shell-forms.js'
import { walkLine } from './shell-scope.js'
import { shellCommands } from './shell-split.js'

export type { Outward, OutwardAction } from './outward-where.js'

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/** A folder a command names, from the folder it runs in; null for one the shell computes. */
function folder(dir: string | null, given: string | undefined): string | null {
  if (dir === null || given === undefined || given === '' || /[$`~*?]/.test(given)) {
    return null
  }
  return path.resolve(dir, given)
}

/** Settings on git's command line that cannot change where or what a push sends. */
const HARMLESS_SETTING = /^(user|color|advice|commit|gpg|i18n)\.|^core\.(pager|editor|quotepath)=|^push\.default=/i

/** Git's own options before its command: the folder it works in, or why Seti cannot follow it. */
function gitGlobals(words: readonly string[], dir: string | null): { at: number; dir: string | null; why?: string } {
  let at = 1
  let where = dir
  let why: string | undefined
  while ((words[at] ?? '').startsWith('-')) {
    const word = words[at] ?? ''
    const paired = word === '-C' || word === '-c' || /^--(git-dir|work-tree|namespace|config-env)$/.test(word)
    if (word === '-C') {
      where = folder(where, words[at + 1])
    } else if (word === '-c' && !HARMLESS_SETTING.test(words[at + 1] ?? '')) {
      why = 'git -c changes its settings'
    } else if (/^--(git-dir|work-tree|namespace|config-env)/.test(word)) {
      why = 'git names another repository or settings'
    }
    at += paired ? 2 : 1
  }
  return why === undefined ? { at, dir: where } : { at, dir: where, why }
}

const PUSH_PAIRED = ['-o', '--push-option', '--repo', '--receive-pack', '--exec']

/** A URL or a path, which git pushes to as given, rather than the name of a remote. */
const isUrl = (named: string) => /^[^/]*:/.test(named) || /^[/.~]/.test(named)

/** Where a `git push` goes: a URL or path it names, a remote, or the default one. */
function gitPush(words: readonly string[], dir: string | null): Outward | null {
  const globals = gitGlobals(words, dir)
  if (words[globals.at] !== 'push') {
    return null
  }
  const args = words.slice(globals.at + 1)
  const why =
    globals.why ??
    (args.some((word) => /^--(recurse-submodules=on-demand|exec|receive-pack)/.test(word))
      ? 'git push runs or pushes more than the folder'
      : undefined)
  if (why !== undefined) {
    return { action: 'push', where: { unknown: why } }
  }
  if (globals.dir === null) {
    return { action: 'push', where: { unknown: 'Seti cannot tell which folder it pushes from' } }
  }
  const named = optionValue(args, ['--repo']) ?? args[positional(args, 0, PUSH_PAIRED)]
  if (named !== undefined && isUrl(named)) {
    return { action: 'push', where: { url: named, dir: globals.dir } }
  }
  return { action: 'push', where: { remote: named ?? null, dir: globals.dir } }
}

const FORK_PAIRED = ['--org', '--fork-name', '--remote-name', '--clone-flags']
const API_PAIRED = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q']
const API_PAIRED_MORE = ['--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Whether a `gh api` call writes: a write method, or fields without a method. */
function apiWrites(args: readonly string[]): boolean {
  const method = optionValue(args, ['-X', '--method'])
  if (method !== undefined) {
    return WRITES.has(method.toUpperCase())
  }
  return args.some((word) => /^(-f|-F|--field|--raw-field|--input)(=|$)/.test(word))
}

/** A fork: of the repository it names, else the folder's; and into the organisation it names. */
function ghFork(args: readonly string[], dir: string | null): Outward[] {
  const source = args[positional(args, 0, FORK_PAIRED)]
  const org = optionValue(args, ['--org'])
  const forked: Outward =
    source === undefined ? current('fork', dir) : { action: 'fork', where: { repo: ghRepo(source) } }
  return org === undefined ? [forked] : [forked, { action: 'fork', where: { owner: org } }]
}

/** An API write to `repos/<owner>/<repo>/...`; `{owner}` stands for the folder's repository. */
function ghApi(api: readonly string[], dir: string | null): Outward[] {
  const endpoint = (api[positional(api, 0, [...API_PAIRED, ...API_PAIRED_MORE])] ?? '').replace(/^\//, '')
  const repo = /^repos\/([^/?]+)\/([^/?]+)/.exec(endpoint)
  if (!apiWrites(api)) {
    return []
  }
  if (repo === null) {
    const unread = /^(repos\/|[$`])/.test(endpoint)
    return unread ? [{ action: 'api', where: { unknown: 'Seti cannot read the API path' } }] : []
  }
  const slug = `${repo[1] ?? ''}/${repo[2] ?? ''}`
  return slug.includes('{') ? [current('api', dir)] : [{ action: 'api', where: { repo: slug } }]
}

/** What a `gh` command sends: a fork, a pull request or another write; `retargeted` under GH_REPO. */
function ghCall(words: readonly string[], dir: string | null, retargeted: boolean): Outward[] {
  const [, group = '', verb = ''] = words
  if (group === 'repo' && verb === 'fork') {
    return ghFork(words.slice(3), dir)
  }
  if (group === 'pr' && verb === 'create') {
    const repo = optionValue(words.slice(3), ['-R', '--repo'])
    if (repo === undefined) {
      return retargeted ? [{ action: 'pr', where: { unknown: 'GH_REPO names the repository' } }] : []
    }
    return [{ action: 'pr', where: { repo: ghRepo(repo) } }]
  }
  return group === 'api' ? ghApi(words.slice(2), dir) : ghWrites(words, dir)
}

const HARMLESS_GIT_ENV =
  /^GIT_(TRACE\w*|TERMINAL_PROMPT|(AUTHOR|COMMITTER)_\w+|EDITOR|PAGER|OPTIONAL_LOCKS|PROGRESS_DELAY)$/

/** A word naming git's files: its folder, its config or a global or module config. */
const GIT_FILES = /(^|\/)\.git(\/|$)|gitconfig|\.config\/git|\.gitmodules/

/** Whether git words change remotes or config rather than read them. */
function rewritesGit(words: readonly string[]): boolean {
  const globals = gitGlobals(words, null)
  const [command, sub] = [words[globals.at], words[globals.at + 1]]
  if (command === 'remote') {
    return !(sub === undefined || ['-v', '--verbose', 'show', 'get-url'].includes(sub))
  }
  const reads = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '-l', '--list', 'get', 'list']
  return command === 'config' && !words.slice(globals.at + 1).some((word) => reads.includes(word))
}

/** Why the line's own words could send a push or a gh call elsewhere than Seti reads, if they do. */
function rerouting(parts: readonly string[]): { git?: string; gh?: string } {
  const words = parts.flatMap((part) => rawWords(part).map(unquote))
  const forms = parts.flatMap((part) => denyForms(part).map((form) => rawWords(form).map(unquote)))
  const assigned = words.flatMap((word) => /^([A-Z_]\w*)=/.exec(word)?.[1] ?? [])
  const changes = forms.some((form) => form[0] === 'git' && rewritesGit(form)) || words.some((w) => GIT_FILES.test(w))
  const env = assigned.some((name) => name.startsWith('GIT_') && !HARMLESS_GIT_ENV.test(name))
  const git = changes ? 'the command changes git remotes or config too' : undefined
  const why = env ? "the command sets git's environment" : git
  const gh = assigned.some((name) => name === 'GH_REPO' || name === 'GH_HOST') ? 'GH_REPO or GH_HOST is set' : undefined
  return { ...(why === undefined ? {} : { git: why }), ...(gh === undefined ? {} : { gh }) }
}

/** A call read in a folder, as unknown when the line itself could send it elsewhere. */
function settled(call: Outward, why: string | undefined): Outward {
  return why === undefined || 'repo' in call.where || 'owner' in call.where || 'unknown' in call.where
    ? call
    : { action: call.action, where: { unknown: why } }
}

/** The calls of one command of the line, read in the folder the line has moved to. */
function callsOf(words: readonly string[], dir: string | null, why: { git?: string; gh?: string }): Outward[] {
  if (words[0] === 'git') {
    const push = gitPush(words, dir)
    return push === null ? [] : [settled(push, why.git)]
  }
  if (words[0] !== 'gh') {
    return []
  }
  const calls = ghCall(words, dir, why.gh !== undefined).map((call) => settled(call, why.git))
  return why.gh === undefined ? calls : calls.map(({ action }) => ({ action, where: { unknown: why.gh ?? '' } }))
}

/** Where a call goes when a shell variable Seti could not read names it. */
function computed(call: Outward): Outward {
  const { where } = call
  const named: unknown[] = 'unknown' in where ? [] : Object.values(where)
  const globbed = ('repo' in where && /[*?[]/.test(where.repo)) || ('owner' in where && /[*?[]/.test(where.owner))
  return globbed || named.some((word) => typeof word === 'string' && /[$`]/.test(word))
    ? { action: call.action, where: { unknown: 'a shell variable names it' } }
    : call
}

/**
 * What a shell line sends to a code host, read past wrappers, nested scripts, `cd` and literal
 * variables: each push, fork, pull request on a named repository, API write to
 * `repos/<owner>/...` and write to a repository's pull requests, issues or releases. A line that
 * changes git's remotes, config or environment, or sets GH_REPO or GH_HOST, leaves them unknown.
 * `home` is what `~` and `$HOME` name for the agent.
 */
export function outwardCalls(command: string, cwd: string | null, home: string | null = null): Outward[] {
  const found: Outward[] = []
  const why = rerouting(shellCommands(command))
  walkLine(command, { cwd, home }, (forms, dir) => {
    found.push(...forms.flatMap((words) => callsOf(words, dir, why)).map(computed))
  })
  const seen = new Set<string>()
  return found.filter((one) => {
    const key = JSON.stringify(one)
    const fresh = !seen.has(key)
    seen.add(key)
    return fresh
  })
}
