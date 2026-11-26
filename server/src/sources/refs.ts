/** What a cited URL names: its ledger key, the keys it falls back to, and how to look for it. */
export interface UrlRef {
  ref: string
  /** Keys of the items that hold it, nearest first: a reply's thread, a message's channel. */
  parents: string[]
  /** Set for a message or item permalink, whose absence from a transcript means it was assembled. */
  needles: string[] | null
  /** Whether items whose key starts with `ref` match, as for a commit named by a short hash. */
  prefix?: true
}

const SLACK_HOST = /^(?:[a-z0-9-]+\.)+slack\.com$/
const CONVERSATION = /^[CDG][A-Z0-9]{8,}$/
const TS = /^\d{10}\.\d{6}$/
const LINEAR_ID = /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/

/** A Slack workspace host, such as `acme.slack.com`, or null for any other host. */
export const slackHost = (host: string): string | null => (SLACK_HOST.test(host) ? host : null)

export const slackChannelRef = (channel: string) => `slack:${channel}`
export const slackMessageRef = (channel: string, ts: string) => `slack:${channel}/${ts}`

/** A message's permalink on a workspace host; a reply's names its thread. */
export function slackPermalink(host: string | null, channel: string, ts?: string, thread?: string): string {
  if (host === null) {
    return ''
  }
  const base = `https://${host}/archives/${channel}`
  if (ts === undefined) {
    return base
  }
  const message = `${base}/p${ts.replace('.', '')}`
  return thread === undefined || thread === ts ? message : `${message}?thread_ts=${thread}&cid=${channel}`
}

export const isConversation = (id: unknown): id is string => typeof id === 'string' && CONVERSATION.test(id)
export const isSlackTs = (ts: unknown): ts is string => typeof ts === 'string' && TS.test(ts)

/** The time a Slack `ts` stands for. */
export const slackTime = (ts: string): string => new Date(Number(ts.split('.')[0]) * 1000).toISOString()

const githubRef = (repo: string, number: number | string) => `github:${repo.toLowerCase()}#${String(number)}`

/** `owner/repo` when both parts are names GitHub allows. */
export function githubRepo(owner: string, repo: string): string | null {
  const ok = GITHUB_NAME.test(owner) && GITHUB_NAME.test(repo) && !repo.startsWith('.')
  return ok ? `${owner}/${repo}` : null
}

/** A file of a GitHub repository at a commit, or as a local copy when `sha` is null. */
export const fileRef = (repo: string, file: string, sha: string | null) => {
  const at = sha === null ? '' : `@${sha}`
  return `file:${repo.toLowerCase()}:${file}${at}`
}

/** A file's page on GitHub at a commit, with the lines it shows. */
export function blobPermalink(repo: string, file: string, sha: string, lines: readonly [number, number] | null) {
  const page = `https://github.com/${repo}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}`
  return lines === null ? page : `${page}#L${String(lines[0])}-L${String(lines[1])}`
}

export const linearRef = (id: string) => `linear:${id}`
export const linearCommentRef = (id: string, comment: string) => `linear:${id}#${comment.toLowerCase()}`
export const isLinearId = (id: unknown): id is string => typeof id === 'string' && LINEAR_ID.test(id)

function slackUrl(url: URL): UrlRef | null {
  const [, archives, channel, message] = url.pathname.split('/')
  if (archives !== 'archives' || !isConversation(channel)) {
    return null
  }
  const digits = message === undefined ? undefined : /^p(\d{16})$/.exec(message)?.[1]
  if (digits === undefined) {
    return message === undefined ? { ref: slackChannelRef(channel), parents: [], needles: null } : null
  }
  const ts = `${digits.slice(0, 10)}.${digits.slice(10)}`
  const thread = url.searchParams.get('thread_ts')
  const threadRef = isSlackTs(thread) && thread !== ts ? [slackMessageRef(channel, thread)] : []
  return {
    ref: slackMessageRef(channel, ts),
    parents: [...threadRef, slackChannelRef(channel)],
    needles: [ts, `p${digits}`],
  }
}

const COMMENT_ANCHOR = /^(issuecomment-|discussion_r|pullrequestreview-)(\d{1,20})$/

const SHA = /^[0-9a-f]{7,40}$/

/** A file at a commit; a URL naming a branch or tag names no version the ledger can hold. */
function blobUrl(repo: string, rest: readonly string[]): UrlRef | null {
  const [sha = '', ...parts] = rest
  let file: string
  try {
    file = parts.map(decodeURIComponent).join('/')
  } catch {
    return null
  }
  if (!SHA.test(sha) || file === '' || parts.includes('')) {
    return null
  }
  const ref = fileRef(repo, file, sha)
  return sha.length === 40 ? { ref, parents: [], needles: null } : { ref, parents: [], needles: null, prefix: true }
}

function githubUrl(url: URL): UrlRef | null {
  const [, owner = '', name = '', type, ...rest] = url.pathname.split('/')
  const repo = githubRepo(owner, name)
  return repo !== null && type === 'blob' ? blobUrl(repo, rest) : itemUrl(url, repo, type, rest)
}

/** A pull request, an issue, or a comment on one. */
function itemUrl(url: URL, repo: string | null, type: string | undefined, rest: readonly string[]): UrlRef | null {
  const [number = '', extra] = rest
  if (repo === null || (type !== 'pull' && type !== 'issues') || !/^\d{1,9}$/.test(number)) {
    return null
  }
  if (extra !== undefined && extra !== '' && type === 'issues') {
    return null
  }
  const item = githubRef(repo, number)
  const lower = repo.toLowerCase()
  const needles = [`${lower}/pull/${number}`, `${lower}/issues/${number}`, `${lower}#${number}`]
  const views = [`pr view ${number}`, `issue view ${number}`, `pulls/${number}`, `issues/${number}`]
  const anchor = COMMENT_ANCHOR.exec(url.hash.slice(1))
  if (anchor === null) {
    return { ref: item, parents: [], needles: [...needles, ...views] }
  }
  const [, prefix = '', id = ''] = anchor
  return { ref: `${item}/${prefix}${id}`, parents: [item], needles: [...needles, ...views, id] }
}

function linearUrl(url: URL): UrlRef | null {
  const [, , issue, id] = url.pathname.split('/')
  if (issue !== 'issue' || !isLinearId(id)) {
    return null
  }
  const comment = /^comment-([0-9a-f]{8})$/.exec(url.hash.slice(1))?.[1]
  return comment === undefined
    ? { ref: linearRef(id), parents: [], needles: null }
    : { ref: linearCommentRef(id, comment), parents: [linearRef(id)], needles: null }
}

/** The ledger key a cited URL names, or null for a URL no adapter records. */
export function refOfUrl(href: string): UrlRef | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null
  }
  if (slackHost(url.hostname) !== null) {
    return slackUrl(url)
  }
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    return githubUrl(url)
  }
  return url.hostname === 'linear.app' ? linearUrl(url) : null
}
