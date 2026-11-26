import { githubRepo } from './refs.js'

/** A `gh pr view` or `gh issue view` the ledger reads; `item` is a number, a URL, or null. */
export interface GhView {
  form: 'view'
  what: 'pr' | 'issue'
  repo: string | null
  item: string | null
  json: boolean
  comments: boolean
}

/** A `gh api` GET of a pull request, an issue, or their comments or reviews. */
export interface GhApi {
  form: 'api'
  repo: string
  /** The number the path names; null for a single comment fetched by its own id. */
  number: string | null
  /** `item` for the pull request or issue itself, `list` for its comments or reviews. */
  shape: 'item' | 'list' | 'one'
}

export type GhRead = GhView | GhApi

const CD = /^cd [\w./~-]+ && /
const STDERR = / 2>(?:\/dev\/null|&1)$/
const UNQUOTED = /[|&;<>()$`\\*?{}[\]!#\n\r]/
const QUOTED = /[$`\\\n\r]/

/** A command's words, or null when it uses any shell feature beyond plain words and quotes. */
function plainWords(command: string): string[] | null {
  const words: string[] = []
  const at: { word: string | null; quote: string | null } = { word: null, quote: null }
  const quoted = (ch: string): boolean => {
    if (ch === at.quote) {
      at.quote = null
      return true
    }
    at.word = `${at.word ?? ''}${ch}`
    return at.quote !== '"' || !QUOTED.test(ch)
  }
  const plain = (ch: string): boolean => {
    if (ch === "'" || ch === '"') {
      at.quote = ch
      at.word ??= ''
    } else if (/\s/.test(ch)) {
      if (at.word !== null) {
        words.push(at.word)
      }
      at.word = null
    } else {
      at.word = `${at.word ?? ''}${ch}`
    }
    return !UNQUOTED.test(ch)
  }
  for (const ch of command) {
    if (!(at.quote === null ? plain(ch) : quoted(ch))) {
      return null
    }
  }
  if (at.word !== null) {
    words.push(at.word)
  }
  return at.quote === null ? words : null
}

const repoOf = (value: string | undefined): string | null => {
  const [owner = '', name = '', ...rest] = (value ?? '').split('/')
  return rest.length === 0 ? githubRepo(owner, name) : null
}

const ITEM = /^(?:\d{1,9}|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d{1,9})$/
const FIELDS = /^[A-Za-z,]+$/
const PAIRED = new Set(['-R', '--repo', '--json'])

/** The words of a view with `--name=value` cut into a name and a value. */
const spread = (words: readonly string[]) =>
  words.flatMap((word) => (word.startsWith('--') && word.includes('=') ? word.split('=', 2) : [word]))

function view(what: 'pr' | 'issue', raw: readonly string[]): GhView | null {
  const words = spread(raw)
  const read: GhView = { form: 'view', what, repo: null, item: null, json: false, comments: false }
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? ''
    const value = PAIRED.has(word) ? words[++i] : undefined
    if (word === '-R' || word === '--repo') {
      read.repo = repoOf(value)
    } else if (word === '--json') {
      read.json = FIELDS.test(value ?? '')
    } else if (word === '-c' || word === '--comments') {
      read.comments = true
    } else if (read.item === null && ITEM.test(word)) {
      read.item = word
    } else {
      return null
    }
    if (PAIRED.has(word) && (word === '--json' ? !read.json : read.repo === null)) {
      return null
    }
  }
  return read
}

const API_ITEM = /^\/?repos\/([^/]+)\/([^/]+)\/(pulls|issues)\/(\d{1,9})(\/comments|\/reviews)?(?:\?[\w=&.-]*)?$/
const API_ONE = /^\/?repos\/([^/]+)\/([^/]+)\/(?:issues\/comments|pulls\/comments)\/\d{1,20}$/

function api(words: readonly string[]): GhApi | null {
  const rest = words.filter((word, i) => !(word === '-X' || words[i - 1] === '-X' || word === '--method=GET'))
  const methods = words.flatMap((word, i) => (word === '-X' ? [words[i + 1]] : []))
  if (rest.length !== 1 || methods.some((method) => method !== 'GET')) {
    return null
  }
  const path = rest[0] ?? ''
  const item = API_ITEM.exec(path)
  if (item !== null) {
    const repo = githubRepo(item[1] ?? '', item[2] ?? '')
    const shape = item[5] === undefined ? 'item' : 'list'
    return repo === null ? null : { form: 'api', repo, number: item[4] ?? null, shape }
  }
  const one = API_ONE.exec(path)
  const repo = one === null ? null : githubRepo(one.at(1) ?? '', one.at(2) ?? '')
  return repo === null ? null : { form: 'api', repo, number: null, shape: 'one' }
}

/** The GitHub read a shell command makes with gh, or null for any other command or form. */
export function ghRead(command: string): GhRead | null {
  const words = plainWords(command.trim().replace(CD, '').replace(STDERR, ''))
  if (words?.[0] !== 'gh') {
    return null
  }
  const [, group, verb, ...rest] = words
  if ((group === 'pr' || group === 'issue') && verb === 'view') {
    return view(group, rest)
  }
  return group === 'api' && verb !== undefined ? api([verb, ...rest]) : null
}
