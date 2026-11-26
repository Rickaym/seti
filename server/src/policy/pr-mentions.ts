import { apiEndpoint, optionValue, positional, rerouting } from './outward.js'
import { walkLine } from './shell-scope.js'
import { shellCommands } from './shell-split.js'

/** A GitHub pull request a command names: by owner and repo, or by number in a folder's repo. */
export type PrMention = { owner: string; repo: string; number: number } | { dir: string; number: number }

/** Where a gh command acts: a named repository or the folder's. */
type Target = Repo | 'folder'

interface Repo {
  owner: string
  repo: string
}

/** A PR a gh command names by number, and where. */
interface Numbered {
  target: Target
  number: number
}

const PR_VERBS = new Set(['merge', 'view', 'close', 'reopen', 'ready', 'comment', 'review', 'checks', 'edit', 'diff'])

/** Options of those verbs that take a value, so a value is never read as the PR. */
const PR_PAIRED = [
  ...['-R', '--repo', '-b', '--body', '-F', '--body-file', '-t', '--title', '--subject', '-A'],
  ...['--author-email', '--match-head-commit', '--json', '-q', '--jq', '--template', '-i', '--interval'],
  ...['-B', '--base', '--milestone', '--add-label', '--remove-label', '--add-reviewer', '--remove-reviewer'],
  ...['--add-assignee', '--remove-assignee', '--add-project', '--remove-project', '--color'],
]

/** Flags whose meaning differs by verb: a value for these verbs, a switch for the others. */
const VERB_PAIRED: Partial<Record<string, readonly string[]>> = {
  close: ['-c', '--comment'],
  reopen: ['-c', '--comment'],
  edit: ['-m'],
}

const NAME = /^[\w.-]+$/
const NUMBER = /^#?(\d{1,9})$/
const PR_URL = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d{1,9})(?:[/?#]\S*)?$/i
const API_PR = /^repos\/([^/?]+)\/([^/?]+)\/pulls\/(\d{1,9})(?:[/?]|$)/

const named = (owner: string, repo: string): Repo | null =>
  NAME.test(owner) && NAME.test(repo) ? { owner, repo: repo.replace(/\.git$/, '') } : null

/** A repository as `-R` takes it: `OWNER/REPO`, `github.com/OWNER/REPO` or its URL. */
function repoOption(given: string): Target | null {
  const parts = given
    .replace(/^https?:\/\//i, '')
    .replace(/\/$/, '')
    .split('/')
  if (parts.length === 3 && parts[0]?.toLowerCase() === 'github.com') {
    return named(parts[1] ?? '', parts[2] ?? '')
  }
  return parts.length === 2 ? named(parts[0] ?? '', parts[1] ?? '') : null
}

function urlMention(word: string): PrMention[] {
  const url = PR_URL.exec(word)
  const target = url === null ? null : named(url[1] ?? '', url[2] ?? '')
  return target === null ? [] : [{ ...target, number: Number(url?.[3]) }]
}

/** The PR a `gh pr <verb>` names by number, and where; null for a branch, a URL or none. */
function prCommand(args: readonly string[]): Numbered | null {
  const [verb = '', ...rest] = args
  if (!PR_VERBS.has(verb)) {
    return null
  }
  const number = NUMBER.exec(rest[positional(rest, 0, [...PR_PAIRED, ...(VERB_PAIRED[verb] ?? [])])] ?? '')
  if (number === null) {
    return null
  }
  const repo = optionValue(rest, ['-R', '--repo'])
  const target = repo === undefined ? 'folder' : repoOption(repo)
  return target === null ? null : { target, number: Number(number[1]) }
}

/** The PR a `gh api repos/<owner>/<repo>/pulls/<n>` call reads or writes on github.com. */
function apiCall(args: readonly string[]): Numbered | null {
  const host = optionValue(args, ['--hostname'])
  const path = API_PR.exec(apiEndpoint(args))
  if (path === null || (host !== undefined && host.toLowerCase() !== 'github.com')) {
    return null
  }
  const [owner = '', repo = ''] = [path[1], path[2]]
  const target = owner === '{owner}' && repo === '{repo}' ? 'folder' : named(owner, repo)
  return target === null ? null : { target, number: Number(path[3]) }
}

function ghCommand([group, ...args]: readonly string[]): Numbered | null {
  if (group === 'pr') {
    return prCommand(args)
  }
  return group === 'api' ? apiCall(args) : null
}

/** The PRs one command of the line names, read in the folder it runs in. */
function mentionsOf(words: readonly string[], dir: string | null, why: { git?: string; gh?: string }): PrMention[] {
  const urls = words.flatMap(urlMention)
  const found = words[0] === 'gh' && why.gh === undefined ? ghCommand(words.slice(1)) : null
  if (found === null) {
    return urls
  }
  if (found.target !== 'folder') {
    return [...urls, { ...found.target, number: found.number }]
  }
  return dir === null || why.git !== undefined ? urls : [...urls, { dir, number: found.number }]
}

const keyOf = (mention: PrMention) =>
  'dir' in mention
    ? `${mention.dir}#${String(mention.number)}`
    : `${mention.owner}/${mention.repo}#${String(mention.number)}`.toLowerCase()

/**
 * The GitHub pull requests a shell line names, read with the walker the outward check uses: a
 * `gh pr` verb with a number, a `gh api repos/<owner>/<repo>/pulls/<n>` path, or a PR's URL as
 * any argument. Without `-R` the PR is in the repository of the folder the command runs in. A
 * part the shell computes, another host, or GH_REPO or GH_HOST set gives no PR.
 */
export function prMentions(command: string, cwd: string | null, home: string | null = null): PrMention[] {
  const why = rerouting(shellCommands(command))
  const found = new Map<string, PrMention>()
  walkLine(command, { cwd, home }, (forms, dir) => {
    for (const mention of forms.flatMap((words) => mentionsOf(words, dir, why))) {
      if (!found.has(keyOf(mention))) {
        found.set(keyOf(mention), mention)
      }
    }
  })
  return [...found.values()]
}
