import { bashCommand } from './outward.js'

/** A PR a tool call names: its number, and its owner/repo when the call says it. */
export interface PrTarget {
  repo: string | null
  number: number
}

const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g
const WORD = /[|;&]+|\n|[^\s|;&]+/g
const SEPARATOR = /^(?:[|;&]+|\n)$/

/** Flags of `gh pr comment` and `gh pr review` that take the next word as their value. */
const VALUE_FLAGS = new Set(['-b', '--body', '-F', '--body-file', '-R', '--repo'])

const PR_LINK = /github\.com\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/(\d+)/
const API_PATH = /(?:^|\/)repos\/([^/\s]+)\/([^/\s]+)\/(?:pulls|issues)\/(\d+)(?:\/|$)/
const NUMBER_FIELDS = ['pull_number', 'pullNumber', 'issue_number', 'issueNumber', 'number']

/** owner/repo from `-R` or a path; null for a placeholder such as `{owner}` or `:owner`. */
function slugOf(owner: string, repo: string): string | null {
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo) ? `${owner}/${repo}` : null
}

function linkTarget(text: string): PrTarget | null {
  const link = PR_LINK.exec(text)
  return link === null ? null : { repo: link[1] ?? null, number: Number(link[2]) }
}

function repoFlag(args: readonly string[]): string | null {
  for (const [index, arg] of args.entries()) {
    const flag = /^(?:-R|--repo)(?:=(.+))?$/.exec(arg)
    if (flag !== null) {
      const [owner = '', repo = ''] = (flag[1] ?? args[index + 1] ?? '').split('/').slice(-2)
      return slugOf(owner, repo)
    }
  }
  return null
}

/** The PR a `gh pr comment` or `gh pr review` names; null for a branch or a variable. */
function ghPrTarget(args: readonly string[]): PrTarget | null {
  const arg = args.find((word, index) => !word.startsWith('-') && !VALUE_FLAGS.has(args[index - 1] ?? ''))
  if (arg === undefined) {
    return null
  }
  const number = /^#?(\d+)$/.exec(arg)
  return number === null ? linkTarget(arg) : { repo: repoFlag(args), number: Number(number[1]) }
}

function ghApiTarget(args: readonly string[]): PrTarget | null {
  for (const arg of args) {
    const path = API_PATH.exec(arg)
    if (path !== null) {
      return { repo: slugOf(path[1] ?? '', path[2] ?? ''), number: Number(path[3]) }
    }
    const link = arg.startsWith('-') ? null : linkTarget(arg)
    if (link !== null) {
      return link
    }
  }
  return null
}

function ghTarget(args: readonly string[]): PrTarget | null {
  const [group = '', action = ''] = args
  if (group === 'api') {
    return ghApiTarget(args.slice(1))
  }
  const posts = ['pr', 'issue'].includes(group) && ['comment', 'review'].includes(action)
  return posts ? ghPrTarget(args.slice(2)) : null
}

/** Shell words with their quotes taken off; a quoted word keeps no spaces or separators inside. */
const shellWords = (command: string): string[] =>
  command.replace(QUOTED, (quoted) => quoted.slice(1, -1).replace(/[\s|;&]/g, '_')).match(WORD) ?? []

/** The PRs the gh commands in a shell command post to, where they name one. */
function bashTargets(command: string): PrTarget[] {
  const words = shellWords(command)
  const targets: PrTarget[] = []
  for (const [index, word] of words.entries()) {
    if (word !== 'gh') {
      continue
    }
    const rest = words.slice(index + 1)
    const end = rest.findIndex((next) => SEPARATOR.test(next))
    const args = end === -1 ? rest : rest.slice(0, end)
    const target = ghTarget(args)
    if (target !== null) {
      targets.push(target)
    }
  }
  return targets
}

function mcpTarget(input: unknown): PrTarget | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const fields = new Map<string, unknown>(Object.entries(input as Record<string, unknown>))
  const number = Number(NUMBER_FIELDS.map((key) => fields.get(key)).find((value) => value !== undefined))
  if (!Number.isInteger(number) || number <= 0) {
    return null
  }
  const owner = fields.get('owner')
  const repo = fields.get('repo')
  if (typeof repo === 'string' && repo.includes('/')) {
    return { repo, number }
  }
  return { repo: typeof owner === 'string' && typeof repo === 'string' ? slugOf(owner, repo) : null, number }
}

/** The PRs a posting call names; empty when it names none, such as `gh pr comment` on the branch. */
export function postTargets(name: string, input: unknown): PrTarget[] {
  if (name === 'Bash') {
    return bashTargets(bashCommand(input))
  }
  const target = mcpTarget(input)
  return target === null ? [] : [target]
}

/** Whether a target is the PR at this URL; a target without a repo matches any repo. */
export function targetsPr(target: PrTarget, url: string): boolean {
  const pr = linkTarget(url)
  if (pr?.number !== target.number) {
    return false
  }
  return target.repo === null || target.repo.toLowerCase() === pr.repo?.toLowerCase()
}
