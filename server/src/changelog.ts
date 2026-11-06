import fs from 'node:fs'
import { CHANGELOG_LIMIT_MAX, type Changelog, type ChangelogEntry, type SetiVersion } from '@seti/shared'
import { git } from './git.js'
import { changelogStore } from './store/changelog.js'

/** A commit's subject and body, read as a conventional commit. */
export interface ParsedCommit {
  type: string | null
  scope: string | null
  breaking: boolean
  description: string
  pr: number | null
  body: string
}

type Commit = Omit<ChangelogEntry, 'current' | 'unseen'>

const CONVENTIONAL = /^(?<type>[a-z]+)(?:\((?<scope>[^()]*)\))?(?<bang>!)?:(?<rest>.*)$/i
const PR_SUFFIX = /\(#(\d+)\)$/
const MERGE_PR = /^Merge pull request #(\d+) from /
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m
const NOTABLE_TYPES = new Set(['feat', 'fix', 'perf'])
const DEPENDENCY_SCOPES = new Set(['deps', 'deps-dev'])

function splitSubject(subject: string): Omit<ParsedCommit, 'body'> {
  const pr = PR_SUFFIX.exec(subject)
  const text = pr === null ? subject : subject.slice(0, pr.index).trimEnd()
  const number = pr?.[1] === undefined ? null : Number(pr[1])
  const groups = CONVENTIONAL.exec(text)?.groups
  const description = groups?.rest?.trim() ?? ''
  if (groups?.type === undefined || description === '') {
    return { type: null, scope: null, breaking: false, description: text.trim(), pr: number }
  }
  const scope = groups.scope?.trim() ?? ''
  return {
    type: groups.type.toLowerCase(),
    scope: scope === '' ? null : scope,
    breaking: groups.bang !== undefined,
    description,
    pr: number,
  }
}

/** Splits a subject such as `fix(ea)!: keep tools in range (#261)`; a merge reads its PR title. */
export function parseCommit(subject: string, body: string): ParsedCommit {
  const merge = MERGE_PR.exec(subject)
  let parsed: Omit<ParsedCommit, 'body'>
  let rest = body.trim()
  if (merge === null) {
    parsed = splitSubject(subject.trim())
  } else {
    const [title = '', ...lines] = rest.split('\n')
    parsed = splitSubject(title.trim() === '' ? subject.trim() : title.trim())
    parsed.pr ??= Number(merge[1])
    rest = lines.join('\n').trim()
  }
  return { ...parsed, breaking: parsed.breaking || BREAKING_FOOTER.test(rest), body: rest }
}

/** Features, fixes and speed-ups count; a dependency bump does not, whatever its type. */
export const isNotable = (commit: Pick<ParsedCommit, 'type' | 'scope'>): boolean =>
  commit.type !== null && NOTABLE_TYPES.has(commit.type) && !DEPENDENCY_SCOPES.has(commit.scope ?? '')

const FIELD = '\x1f'
const RECORD = '\x1e'

const isoDate = (date: string) => new Date(date).toISOString()

async function readVersion(dir: string): Promise<SetiVersion | null> {
  try {
    const top = await git(dir, 'rev-parse', '--show-toplevel')
    if (fs.realpathSync(top) !== fs.realpathSync(dir)) {
      return null
    }
    const [commit, date] = (await git(dir, 'log', '-1', `--format=%H${FIELD}%cI`, 'HEAD')).split(FIELD)
    return commit === undefined || date === undefined ? null : { commit, date: isoDate(date) }
  } catch {
    return null
  }
}

const versions = new Map<string, Promise<SetiVersion | null>>()

/** The commit Seti started at, read once, so a checkout moved under it does not change it. */
export async function runningVersion(dir: string): Promise<SetiVersion | null> {
  const found = versions.get(dir)
  if (found !== undefined) {
    return found
  }
  const read = readVersion(dir)
  versions.set(dir, read)
  return read
}

/** Notes the running commit as a deploy, so the next one knows what it brought. */
export async function recordRunningVersion(dir: string): Promise<void> {
  const version = await runningVersion(dir)
  if (version !== null) {
    await changelogStore.recordDeploy(version.commit)
  }
}

/** First-parent commits of `range`, newest first, at most `max` of them. */
export async function readCommits(dir: string, range: string, max: number): Promise<Commit[]> {
  const format = ['%H', '%cI', '%s', '%b'].join(FIELD) + RECORD
  const out = await git(dir, 'log', '--first-parent', `-n${String(max)}`, `--format=${format}`, range)
  return out.split(RECORD).flatMap((record) => {
    const [commit, date, subject, body] = record.replace(/^\n/, '').split(FIELD)
    if (commit === undefined || date === undefined || subject === undefined || commit === '') {
      return []
    }
    const parsed = parseCommit(subject, body ?? '')
    return [{ commit, date: isoDate(date), ...parsed, notable: isNotable(parsed) }]
  })
}

const histories = new Map<string, Promise<Commit[]>>()

async function history(dir: string, head: string): Promise<Commit[]> {
  const key = `${dir}\n${head}`
  const found = histories.get(key)
  if (found !== undefined) {
    return found
  }
  const read = readCommits(dir, head, CHANGELOG_LIMIT_MAX + 1).catch(() => [])
  histories.set(key, read)
  return read
}

/** Commits on the first-parent line after `base` up to `head`; null when git does not know `base`. */
async function since(dir: string, base: string, head: string): Promise<Set<string> | null> {
  try {
    const out = await git(dir, 'rev-list', '--first-parent', `${base}..${head}`)
    return new Set(out.split('\n').filter((line) => line !== ''))
  } catch {
    return null
  }
}

/**
 * The newest `limit` commits of the running version. Entries after the previous deploy are
 * current; notable ones after the commit the user last saw, or else the current ones, are unseen.
 */
export async function readChangelog(dir: string, limit: number): Promise<Changelog> {
  const version = await runningVersion(dir)
  if (version === null) {
    return { version: null, unseen: 0, entries: [], has_more: false }
  }
  const [commits, previous, seen] = await Promise.all([
    history(dir, version.commit),
    changelogStore.previousDeploy(version.commit),
    changelogStore.seen(),
  ])
  const current = (previous === null ? null : await since(dir, previous, version.commit)) ?? new Set<string>()
  const after = (seen === null ? null : await since(dir, seen, version.commit)) ?? current
  const unseen = (commit: Commit) => commit.notable && after.has(commit.commit)
  return {
    version,
    unseen: commits.filter(unseen).length,
    entries: commits
      .slice(0, limit)
      .map((commit) => ({ ...commit, current: current.has(commit.commit), unseen: unseen(commit) })),
    has_more: commits.length > limit,
  }
}
