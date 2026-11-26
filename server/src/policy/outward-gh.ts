import { current, ghRepo, optionValue, type GhWrite, type Outward } from './outward-where.js'

/** How a gh write names what it writes to: numbers, URLs or branches, or only its repository. */
interface GhWriteForm {
  /** Options that take a value, beside `-R` and `--repo`. */
  paired: readonly string[]
  /** Whether its words name pull requests or issues, by number, URL or branch. */
  items: boolean
}

const BODY = ['-b', '--body', '-F', '--body-file']
const COMMENT = ['-c', '--comment']
const REASON = ['-r', '--reason']
const EDITS = ['--add-assignee', '--remove-assignee', '--add-label', '--remove-label', '--add-project']
const EDIT = [...BODY, ...EDITS, '--remove-project', '-m', '--milestone', '-t', '--title']
const NOTES = ['-n', '--notes', '-F', '--notes-file', '-t', '--title', '--target', '--tag', '--discussion-category']
const ISSUE_NEW = [...BODY, '-a', '--assignee', '-l', '--label', '-p', '--project', '-m', '--milestone', '-T']

const item = (paired: readonly string[] = []): GhWriteForm => ({ paired, items: true })
const whole = (paired: readonly string[] = []): GhWriteForm => ({ paired, items: false })

/** Every gh command that writes to a repository's pull requests, issues or releases. */
const GH_WRITES: Record<GhWrite, GhWriteForm> = {
  'pr comment': item(BODY),
  'pr review': item(BODY),
  'pr merge': item([...BODY, '-A', '--author-email', '--match-head-commit', '-t', '--subject']),
  'pr close': item(COMMENT),
  'pr reopen': item(COMMENT),
  'pr ready': item(),
  'pr edit': item([...EDIT, '-B', '--base', '--add-reviewer', '--remove-reviewer']),
  'pr lock': item(REASON),
  'pr unlock': item(),
  'pr update-branch': item(),
  'pr revert': item([...BODY, '-t', '--title']),
  'issue create': whole([...ISSUE_NEW, '--template', '-t', '--title', '--recover']),
  'issue comment': item(BODY),
  'issue close': item([...COMMENT, ...REASON]),
  'issue reopen': item(COMMENT),
  'issue edit': item(EDIT),
  'issue delete': item(),
  'issue lock': item(REASON),
  'issue unlock': item(),
  'issue pin': item(),
  'issue unpin': item(),
  'issue transfer': item(),
  'issue develop': item(['-b', '--base', '--branch-repo', '-n', '--name']),
  'release create': whole([...NOTES, '--notes-start-tag']),
  'release edit': whole(NOTES),
  'release delete': whole(),
  'release upload': whole(),
  'release delete-asset': whole(),
}

const ALIASES: Readonly<Record<string, string>> = { 'issue new': 'issue create', 'release new': 'release create' }

const isGhWrite = (named: string): named is GhWrite => Object.hasOwn(GH_WRITES, named)

/** The words that are no option nor an option's value, all of them after `--`. */
function positionals(words: readonly string[], paired: readonly string[]): string[] {
  const found: string[] = []
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at] ?? ''
    if (word === '--') {
      return [...found, ...words.slice(at + 1)]
    }
    if (!word.startsWith('-')) {
      found.push(word)
    } else if (paired.includes(word)) {
      at += 1
    }
  }
  return found
}

/** The repository of a pull request or issue URL, as in https://github.com/acme/tool/pull/3. */
const ITEM_URL = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+)\/(pull|pulls|issues)(\/|$)/

/**
 * Where a word naming a pull request or issue points: the repository of its URL, null for a
 * number or branch (the command's repository), or unknown for a URL Seti cannot read. A whole
 * word the shell computes reads as a number; a computed part of a URL's owner or repository
 * does not.
 */
function itemRepo(action: GhWrite, word: string): Outward | null {
  const url = ITEM_URL.exec(word)
  if (url !== null) {
    return { action, where: { repo: url[1] ?? '' } }
  }
  const urlLike = word.includes('://') || (/^[$`]/.test(word) && word.includes('/'))
  return urlLike ? { action, where: { unknown: 'Seti cannot read the URL' } } : null
}

/** The repository a gh command acts on when no URL names one: `-R`, else the folder's. */
function commandRepo(action: GhWrite, args: readonly string[], dir: string | null): Outward {
  const joined = args.find((word) => /^-R./.test(word))?.slice(2)
  const repo = optionValue(args, ['-R', '--repo']) ?? joined
  return repo === undefined ? current(action, dir) : { action, where: { repo: ghRepo(repo) } }
}

/** Repositories a gh command also writes to: an issue's new repository or its branch's. */
function alsoWritten(action: GhWrite, args: readonly string[], named: readonly string[]): Outward[] {
  const other = action === 'issue transfer' ? named[1] : optionValue(args, ['--branch-repo'])
  return other === undefined ? [] : [{ action, where: { repo: ghRepo(other) } }]
}

/**
 * What a gh command writes to a repository's pull requests, issues or releases: the repository
 * of each URL it names, and `-R` or the folder's repository for a number, a branch or nothing.
 */
export function ghWrites(words: readonly string[], dir: string | null): Outward[] {
  const [, group = '', verb = ''] = words
  const named = ALIASES[`${group} ${verb}`] ?? `${group} ${verb}`
  if (!isGhWrite(named)) {
    return []
  }
  const args = words.slice(3)
  if (named === 'issue develop' && args.some((word) => word === '-l' || word === '--list')) {
    return []
  }
  const form = GH_WRITES[named]
  const given = positionals(args, [...form.paired, '-R', '--repo'])
  const last = named === 'issue transfer' ? 1 : given.length
  const items = form.items ? given.slice(0, last) : []
  const read = items.map((word) => itemRepo(named, word))
  const byUrl = read.filter((one): one is Outward => one !== null)
  const own = read.length === 0 || read.includes(null) ? [commandRepo(named, args, dir)] : []
  return [...byUrl, ...own, ...alsoWritten(named, args, given)]
}
