import path from 'node:path'
import { denyForms, rawWords } from './shell-forms.js'
import { splitShell } from './shell-split.js'

/** What a command sends to a code host: a push, a fork, a pull request or an API write. */
export type OutwardAction = 'push' | 'fork' | 'pr' | 'api'

/**
 * Where it goes: a repository the command names (a URL or owner/repo), a remote of the repository
 * in a folder (null for the one git pushes to by default), or a place Seti cannot read.
 */
export type OutwardWhere =
  { repo: string } | { owner: string } | { remote: string | null; dir: string } | { unknown: string }

export interface Outward {
  action: OutwardAction
  where: OutwardWhere
}

const unquote = (word: string) => word.replace(/\\(.)/g, '$1').replace(/["']/g, '')

/** A folder a command names, from the folder it runs in; null for one the shell computes. */
function folder(dir: string | null, given: string | undefined): string | null {
  if (dir === null || given === undefined || given === '' || /[$`~*?]/.test(given)) {
    return null
  }
  return path.resolve(dir, given)
}

/** The index of the first word from `at` that is no option, skipping the values of `paired`. */
function positional(words: readonly string[], at: number, paired: readonly string[]): number {
  let next = at
  while ((words[next] ?? '').startsWith('-')) {
    next += paired.includes(words[next] ?? '') ? 2 : 1
  }
  return next
}

/** The value of an option given as `--name value`, `--name=value` or `-x value`, or undefined. */
function optionValue(words: readonly string[], names: readonly string[]): string | undefined {
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? ''
    const joined = names.find((name) => name.startsWith('--') && word.startsWith(`${name}=`))
    if (joined !== undefined) {
      return word.slice(joined.length + 1)
    }
    if (names.includes(word)) {
      return words[at + 1]
    }
  }
  return undefined
}

/** Config on git's command line that changes where a push goes. */
const REROUTES = /(^(url|remote|branch)\.)|insteadof/i

/** Git's own options before its command: the folder it works in, or why Seti cannot follow it. */
function gitGlobals(words: readonly string[], dir: string | null): { at: number; dir: string | null; why?: string } {
  let at = 1
  let where = dir
  let why: string | undefined
  while ((words[at] ?? '').startsWith('-')) {
    const word = words[at] ?? ''
    const paired = word === '-C' || word === '-c' || /^--(git-dir|work-tree|namespace)$/.test(word)
    if (word === '-C') {
      where = folder(where, words[at + 1])
    } else if (word === '-c' && REROUTES.test(words[at + 1] ?? '')) {
      why = 'git -c changes where it pushes'
    } else if (/^--(git-dir|work-tree|namespace)/.test(word)) {
      why = 'git names another repository'
    }
    at += paired ? 2 : 1
  }
  return why === undefined ? { at, dir: where } : { at, dir: where, why }
}

const PUSH_PAIRED = ['-o', '--push-option', '--repo', '--receive-pack', '--exec']

/** Where a `git push` goes: a URL or path it names, a remote, or the default one. */
function gitPush(words: readonly string[], dir: string | null): Outward | null {
  const globals = gitGlobals(words, dir)
  if (words[globals.at] !== 'push') {
    return null
  }
  if (globals.why !== undefined) {
    return { action: 'push', where: { unknown: globals.why } }
  }
  const args = words.slice(globals.at + 1)
  const named = optionValue(args, ['--repo']) ?? args[positional(args, 0, PUSH_PAIRED)]
  if (named !== undefined && /[:/]/.test(named)) {
    return { action: 'push', where: { repo: named } }
  }
  if (globals.dir === null) {
    return { action: 'push', where: { unknown: 'Seti cannot tell which folder it pushes from' } }
  }
  return { action: 'push', where: { remote: named ?? null, dir: globals.dir } }
}

const FORK_PAIRED = ['--org', '--fork-name', '--remote-name', '--clone-flags']
const API_PAIRED = ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-q']
const API_PAIRED_MORE = ['--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** A repository gh acts on by default: the one in the folder, by its `origin`. */
const current = (action: OutwardAction, dir: string | null): Outward =>
  dir === null
    ? { action, where: { unknown: 'Seti cannot tell which repository it acts on' } }
    : { action, where: { remote: 'origin', dir } }

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
  const forked: Outward = source === undefined ? current('fork', dir) : { action: 'fork', where: { repo: source } }
  return org === undefined ? [forked] : [forked, { action: 'fork', where: { owner: org } }]
}

/** What a `gh` command sends: a fork, a pull request on a repository it names, an API write. */
function ghCall(words: readonly string[], dir: string | null): Outward[] {
  const [, group = '', verb = ''] = words
  if (group === 'repo' && verb === 'fork') {
    return ghFork(words.slice(3), dir)
  }
  if (group === 'pr' && verb === 'create') {
    const repo = optionValue(words.slice(3), ['-R', '--repo'])
    return repo === undefined ? [] : [{ action: 'pr', where: { repo } }]
  }
  return group === 'api' ? ghApi(words.slice(2), dir) : []
}

/** An API write to `repos/<owner>/<repo>/...`; `{owner}` stands for the folder's repository. */
function ghApi(api: readonly string[], dir: string | null): Outward[] {
  const endpoint = (api[positional(api, 0, [...API_PAIRED, ...API_PAIRED_MORE])] ?? '').replace(/^\//, '')
  const repo = /^repos\/([^/?]+)\/([^/?]+)/.exec(endpoint)
  if (repo === null || !apiWrites(api)) {
    return []
  }
  const slug = `${repo[1] ?? ''}/${repo[2] ?? ''}`
  return slug.includes('{') ? [current('api', dir)] : [{ action: 'api', where: { repo: slug } }]
}

/** The folder a `cd` or `pushd` moves to, or undefined when the command is neither. */
function moves(words: readonly string[], dir: string | null): string | null | undefined {
  if (words[0] !== 'cd' && words[0] !== 'pushd') {
    return undefined
  }
  return folder(
    dir,
    words.slice(1).find((word) => !word.startsWith('-')),
  )
}

/**
 * What a shell line sends to a code host, read past wrappers, nested scripts and `cd`: each push,
 * fork, pull request on a named repository and API write to `repos/<owner>/...`.
 */
export function outwardCalls(command: string, cwd: string | null): Outward[] {
  const found: Outward[] = []
  let dir = cwd
  for (const part of splitShell(command).all) {
    const forms = denyForms(part).map((form) => rawWords(form).map(unquote))
    const moved = moves(forms[forms.length - 1] ?? [], dir)
    if (moved !== undefined) {
      dir = moved
      continue
    }
    for (const words of forms) {
      if (words[0] === 'git') {
        found.push(...[gitPush(words, dir)].filter((one): one is Outward => one !== null))
      } else if (words[0] === 'gh') {
        found.push(...ghCall(words, dir))
      }
    }
  }
  const seen = new Set<string>()
  return found.filter((one) => {
    const key = JSON.stringify(one)
    const fresh = !seen.has(key)
    seen.add(key)
    return fresh
  })
}
