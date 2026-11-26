import { cleanJq } from './gh-filters.js'
import { githubRepo } from './refs.js'

/**
 * How a read's own options shape its output: as gh prints it, cut by a jq program that adds no
 * text of its own, or by a program or template that can print anything.
 */
export type GhFilter = 'none' | 'clean' | 'any'

/** A `gh pr|issue view` or `gh pr diff` the ledger reads; `item` is a number, a URL, or null. */
export interface GhView {
  form: 'view' | 'diff'
  what: 'pr' | 'issue'
  repo: string | null
  item: string | null
  json: boolean
  comments: boolean
  filter: GhFilter
}

/** A `gh api` GET of a pull request, an issue, or their comments or reviews. */
export interface GhApi {
  form: 'api'
  repo: string
  /** The number the path names; null for a single comment fetched by its own id. */
  number: string | null
  /** Whether the path names a pull request rather than an issue. */
  pull: boolean
  /** `item` for the pull request or issue itself, `list` for its comments or reviews. */
  shape: 'item' | 'list' | 'one'
  filter: GhFilter
}

export type GhRead = GhView | GhApi

const repoOf = (value: string | undefined): string | null => {
  const [owner = '', name = '', ...rest] = (value ?? '').split('/')
  return rest.length === 0 ? githubRepo(owner, name) : null
}

const ITEM = /^(?:\d{1,9}|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d{1,9})$/
const FIELDS = /^[A-Za-z,]+$/
const VIEW_PAIRED = new Set(['-R', '--repo', '--json', '-q', '--jq', '-t', '--template', '--color'])
const API_PAIRED = new Set(['-X', '--method', '-q', '--jq', '-t', '--template'])

/** The words with `--name=value` cut into a name and a value, and `-Rvalue` into `-R value`. */
const spread = (words: readonly string[]) =>
  words.flatMap((word) => {
    if (word.startsWith('--') && word.includes('=')) {
      return word.split('=', 2)
    }
    return /^-R./.test(word) ? ['-R', word.slice(2)] : [word]
  })

/** A read's options as name and value, its other words apart; null when a value is missing. */
function options(words: readonly string[], paired: ReadonlySet<string>) {
  const named = new Map<string, string>()
  const rest: string[] = []
  const spreadWords = spread(words)
  for (let i = 0; i < spreadWords.length; i++) {
    const word = spreadWords[i] ?? ''
    if (paired.has(word)) {
      const value = spreadWords[++i]
      if (value === undefined || named.has(word)) {
        return null
      }
      named.set(word, value)
    } else {
      rest.push(word)
    }
  }
  return { named, rest }
}

const valueOf = (named: ReadonlyMap<string, string>, ...names: string[]) =>
  names.map((name) => named.get(name)).find((value) => value !== undefined)

function filterOf(named: ReadonlyMap<string, string>): GhFilter | null {
  const jq = valueOf(named, '-q', '--jq')
  const template = valueOf(named, '-t', '--template')
  if (jq !== undefined && template !== undefined) {
    return null
  }
  if (template !== undefined) {
    return 'any'
  }
  if (jq === undefined) {
    return 'none'
  }
  return cleanJq(jq) ? 'clean' : 'any'
}

const VIEW_FLAGS = new Set(['-c', '--comments'])
const DIFF_FLAGS = new Set(['--name-only', '--patch'])

/** A view's or diff's options as read, before they are checked against each other. */
interface ViewWords {
  form: 'view' | 'diff'
  json: string | undefined
  repoName: string | undefined
  items: string[]
  filter: GhFilter
}

function viewFits({ form, json, repoName, items, filter }: ViewWords): boolean {
  const item = items[0]
  return (
    (repoName === undefined || repoOf(repoName) !== null) &&
    (json === undefined || (form === 'view' && FIELDS.test(json))) &&
    (filter === 'none' || json !== undefined) &&
    items.length <= 1 &&
    (item === undefined || ITEM.test(item))
  )
}

function view(form: 'view' | 'diff', what: 'pr' | 'issue', words: readonly string[]): GhView | null {
  const read = options(words, VIEW_PAIRED)
  const filter = read === null ? null : filterOf(read.named)
  if (read === null || filter === null) {
    return null
  }
  const json = valueOf(read.named, '--json')
  const repoName = valueOf(read.named, '-R', '--repo')
  const flags = form === 'view' ? VIEW_FLAGS : DIFF_FLAGS
  const items = read.rest.filter((word) => !flags.has(word))
  if (!viewFits({ form, json, repoName, items, filter })) {
    return null
  }
  const repo = repoName === undefined ? null : repoOf(repoName)
  const comments = read.rest.some((word) => VIEW_FLAGS.has(word))
  return { form, what, repo, item: items[0] ?? null, json: json !== undefined, comments, filter }
}

const API_ITEM = /^\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d{1,9})(\/comments|\/reviews)?(?:\?[\w=&.-]*)?$/
const API_ONE = /^\/?repos\/([^/]+)\/([^/]+)\/(issues|pulls)\/comments\/\d{1,20}$/

/** What an API path names: a pull request or issue, its comments or reviews, or one comment. */
function apiPath(path: string, filter: GhFilter): GhApi | null {
  const item = API_ITEM.exec(path)
  if (item !== null) {
    const repo = githubRepo(item[1] ?? '', item[2] ?? '')
    const shape = item[5] === undefined ? 'item' : 'list'
    const pull = item[3] === 'pulls'
    return repo === null ? null : { form: 'api', repo, number: item[4] ?? null, pull, shape, filter }
  }
  const one = API_ONE.exec(path)
  const repo = one === null ? null : githubRepo(one.at(1) ?? '', one.at(2) ?? '')
  return repo === null ? null : { form: 'api', repo, number: null, pull: one?.[3] === 'pulls', shape: 'one', filter }
}

/** A GET of one path, with no option beside the method, a filter and `--paginate`. */
function api(words: readonly string[]): GhApi | null {
  const read = options(words, API_PAIRED)
  if (read === null) {
    return null
  }
  const filter = filterOf(read.named)
  const method = valueOf(read.named, '-X', '--method') ?? 'GET'
  const rest = read.rest.filter((word) => word !== '--paginate')
  const [path] = rest
  if (filter === null || rest.length !== 1 || path === undefined || method.toUpperCase() !== 'GET') {
    return null
  }
  return apiPath(path, filter)
}

/** The GitHub read one gh command makes, from its expanded words, or null for any other form. */
export function ghRead(words: readonly string[]): GhRead | null {
  const [program, group, verb, ...rest] = words
  if (program !== 'gh') {
    return null
  }
  if ((group === 'pr' || group === 'issue') && verb === 'view') {
    return view('view', group, rest)
  }
  if (group === 'pr' && verb === 'diff') {
    return view('diff', group, rest)
  }
  return group === 'api' && verb !== undefined ? api([verb, ...rest]) : null
}
