import type { PrInput, PrQuietReason } from '@seti/shared'
import type { PrAuthor, WatchedPr, WatchedReview } from './github.js'

/** What Seti last reported about a PR, so only changes become updates. */
export interface PrSnapshot {
  state: WatchedPr['state']
  conflicting: boolean
  /**
   * The last CI result reported per head commit, with the failing checks already named. `rerun`
   * marks checks seen running again on that commit since.
   */
  ci: { oid: string; state: 'success' | 'failure'; failing?: string[]; rerun?: true } | null
  /** The base branch and head commit of the conflict reported last, until it merges cleanly. */
  conflict?: { base: string; head: string }
  review_ids: string[]
  comment_ids: string[]
}

const BODY_CHARS = 4000
const COMMENT_CHARS = 1500
const MAX_CHECKS = 20
const MAX_POSTS = 20
/** A comment or review this close to a PR's end, before or after it, is what ended it. */
const CLOSING_MS = 2 * 60_000
const UNLINKED = 'Seti unlinked it from this agent; its updates stop here.'

/** What the task that reads the updates did on the PR itself, which Seti does not tell it again. */
export interface PrReader {
  /** Ids of the new reviews and comments it posted. */
  posts?: ReadonlySet<string>
  /** It merged or closed the PR. */
  ended?: boolean
  /** False when it pushed nothing whose CI result it could be waiting for. */
  awaitsCi?: boolean
}

const quieted = (input: PrInput, quiet: PrQuietReason | null): PrInput => (quiet === null ? input : { ...input, quiet })

const clip = (text: string, max: number, url: string) =>
  text.length <= max ? text : `${text.slice(0, max)}\n[... clipped, full text: ${url}]`

const shortOid = (oid: string) => oid.slice(0, 7)

function snapshotOf(pr: WatchedPr, ci: PrSnapshot['ci'], conflict?: PrSnapshot['conflict']): PrSnapshot {
  return {
    state: pr.state,
    conflicting: pr.conflicting,
    ci,
    ...(conflict === undefined ? {} : { conflict }),
    review_ids: pr.reviews.filter((review) => review.state !== 'PENDING').map((review) => review.id),
    comment_ids: pr.comments.map((comment) => comment.id),
  }
}

/** What a conflict is between; undefined when GitHub names no base or head to tell it by. */
const conflictOf = (pr: WatchedPr): PrSnapshot['conflict'] =>
  pr.conflicting && pr.base_ref !== null && pr.head_oid !== null ? { base: pr.base_ref, head: pr.head_oid } : undefined

const failingChecks = (pr: WatchedPr) => pr.checks.filter((check) => check.state === 'failure')

function finishedCi(pr: WatchedPr): PrSnapshot['ci'] {
  if (pr.head_oid === null || (pr.ci !== 'success' && pr.ci !== 'failure')) {
    return null
  }
  if (pr.ci === 'success') {
    return { oid: pr.head_oid, state: pr.ci }
  }
  return { oid: pr.head_oid, state: pr.ci, failing: failingChecks(pr).map((check) => check.name) }
}

function checkLines(checks: WatchedPr['checks']): string[] {
  const lines = checks.slice(0, MAX_CHECKS).map((check) => {
    const link = check.url === null ? '' : `: ${check.url}`
    return `- ${check.name} (${check.detail})${link}`
  })
  const more = checks.length > MAX_CHECKS ? [`- and ${String(checks.length - MAX_CHECKS)} more`] : []
  return [...lines, ...more]
}

/** Checks that failed on the same commit after its failure was reported, as slower jobs finish. */
function lateFailureInput(pr: WatchedPr, ci: NonNullable<PrSnapshot['ci']>, known: string[]): PrInput | null {
  const late = failingChecks(pr).filter((check) => !known.includes(check.name))
  if (late.length === 0) {
    return null
  }
  return {
    source: 'pr',
    kind: 'ci_failed',
    subject: pr.subject,
    title: `More checks failed on ${pr.subject}`,
    body: [`Also failing on ${shortOid(ci.oid)}, after the checks reported earlier:`, ...checkLines(late)].join('\n'),
    url: pr.url,
  }
}

function ciInput(pr: WatchedPr, ci: NonNullable<PrSnapshot['ci']>): PrInput {
  if (ci.state === 'success') {
    return {
      source: 'pr',
      kind: 'ci_passed',
      subject: pr.subject,
      title: `CI passed on ${pr.subject}`,
      body: `Every check passed on ${shortOid(ci.oid)}.`,
      url: pr.url,
    }
  }
  return {
    source: 'pr',
    kind: 'ci_failed',
    subject: pr.subject,
    title: `CI failed on ${pr.subject}`,
    body: [`Failing checks on ${shortOid(ci.oid)}:`, ...checkLines(failingChecks(pr))].join('\n'),
    url: pr.url,
  }
}

/** How a review reads in an update's title, and on its own line among several. */
const REVIEW_VERBS: Record<string, { title: string; line: string }> = {
  APPROVED: { title: 'approved', line: 'approved' },
  CHANGES_REQUESTED: { title: 'requested changes on', line: 'requested changes' },
  COMMENTED: { title: 'reviewed', line: 'reviewed' },
}

const COMMENT_VERB = { title: 'commented on', line: 'commented' }

/** A new review or comment, as one entry of an update. */
interface Post {
  id: string
  kind: 'review' | 'comment'
  at: string
  author: string
  verb: { title: string; line: string }
  body: string
  inline: WatchedReview['comments']
  url: string
}

/** A new review or comment the agents may have written themselves, which the poller checks. */
export interface PrPost {
  id: string
  url: string
  /** Links of a review's inline comments; empty for a comment. */
  inline: string[]
  login: string | null
  at: string | null
}

function inlineLines(post: Post): string[] {
  return post.inline.map((comment) => {
    const where = comment.line === null ? comment.path : `${comment.path}:${String(comment.line)}`
    return `- [${where}](${comment.url}): ${clip(comment.body, COMMENT_CHARS, comment.url)}`
  })
}

function postText(post: Post, max: number): string {
  const text = post.body.trim() === '' ? '' : clip(post.body, max, post.url)
  const inline = inlineLines(post)
  const comments = inline.length === 0 ? '' : ['Inline comments:', ...inline].join('\n')
  return [text, comments].filter((part) => part !== '').join('\n\n')
}

const singleInput = (pr: WatchedPr, post: Post): PrInput => ({
  source: 'pr',
  kind: post.kind,
  subject: pr.subject,
  title: `${post.author} ${post.verb.title} ${pr.subject}`,
  body: postText(post, BODY_CHARS),
  url: post.url,
})

/** Several reviews and comments from one poll, as one update the agent reads at once. */
function batchInput(pr: WatchedPr, posts: readonly Post[]): PrInput {
  const allComments = posts.every((post) => post.kind === 'comment')
  const sections = posts.slice(0, MAX_POSTS).map((post) => {
    const text = postText(post, COMMENT_CHARS)
    const head = `**${post.author}** ${post.verb.line} ([open](${post.url}))`
    return text === '' ? head : `${head}:\n\n${text}`
  })
  const more = posts.length > MAX_POSTS ? [`And ${String(posts.length - MAX_POSTS)} more on ${pr.url}`] : []
  return {
    source: 'pr',
    kind: allComments ? 'comment' : 'review',
    subject: pr.subject,
    title: `${String(posts.length)} new ${allComments ? 'comments' : 'reviews and comments'} on ${pr.subject}`,
    body: [...sections, ...more].join('\n\n---\n\n'),
    url: pr.url,
  }
}

const authorName = (author: PrAuthor | null) => author?.login ?? 'Someone'

/** Submitted reviews Seti has not seen; a pending one stays unseen until its author submits it. */
const freshReviews = (previous: PrSnapshot, pr: WatchedPr) =>
  pr.reviews.filter((review) => REVIEW_VERBS[review.state] !== undefined && !previous.review_ids.includes(review.id))

/** Bot comments restate CI, previews and scans on every push; the CI result already covers them. */
const freshComments = (previous: PrSnapshot, pr: WatchedPr) =>
  pr.comments.filter((comment) => !previous.comment_ids.includes(comment.id) && comment.author?.bot !== true)

/** The new reviews and comments that would become updates, for the poller to check who wrote them. */
export function freshPosts(previous: PrSnapshot | undefined, pr: WatchedPr): PrPost[] {
  if (previous?.state !== 'open') {
    return []
  }
  const reviews = freshReviews(previous, pr).map((review) => ({
    id: review.id,
    url: review.url,
    inline: review.comments.map((comment) => comment.url),
    login: review.author?.login ?? null,
    at: review.submitted_at,
  }))
  const comments = freshComments(previous, pr).map((comment) => ({
    id: comment.id,
    url: comment.url,
    inline: [],
    login: comment.author?.login ?? null,
    at: comment.created_at,
  }))
  return [...reviews, ...comments]
}

function reviewPosts(previous: PrSnapshot, pr: WatchedPr): Post[] {
  return freshReviews(previous, pr).flatMap((review): Post[] => {
    const verb = REVIEW_VERBS[review.state]
    if (verb === undefined) {
      return []
    }
    const post: Post = {
      id: review.id,
      kind: 'review',
      at: review.submitted_at ?? '',
      author: authorName(review.author),
      verb,
      body: review.body,
      inline: review.comments,
      url: review.url,
    }
    return [post]
  })
}

const commentPosts = (previous: PrSnapshot, pr: WatchedPr): Post[] =>
  freshComments(previous, pr).map((comment) => ({
    id: comment.id,
    kind: 'comment',
    at: comment.created_at,
    author: authorName(comment.author),
    verb: COMMENT_VERB,
    body: comment.body,
    inline: [],
    url: comment.url,
  }))

/** New reviews and comments from people, review bots and agents, oldest first. */
const newPosts = (previous: PrSnapshot, pr: WatchedPr): Post[] =>
  [...reviewPosts(previous, pr), ...commentPosts(previous, pr)].toSorted((a, b) => a.at.localeCompare(b.at))

function postInputs(pr: WatchedPr, posts: readonly Post[]): PrInput[] {
  const [only] = posts
  if (only === undefined) {
    return []
  }
  return posts.length === 1 ? [singleInput(pr, only)] : [batchInput(pr, posts)]
}

/** The posts that came with the PR's end, such as the comment of "Close with comment". */
function closingPosts(pr: WatchedPr, posts: readonly Post[]): Post[] {
  const end = pr.closed_at === null ? Number.NaN : Date.parse(pr.closed_at)
  return posts.filter((post) => Math.abs(Date.parse(post.at) - end) <= CLOSING_MS)
}

function closingLine(post: Post): string {
  const head = post.kind === 'comment' ? post.author : `${post.author} ${post.verb.line}`
  const text = postText(post, COMMENT_CHARS)
  const link = `([open](${post.url}))`
  return text === '' ? `${head} ${link}` : `${head}: ${text} ${link}`
}

function stateInput(pr: WatchedPr, closing: readonly Post[]): PrInput {
  const merged = pr.state === 'merged'
  return {
    source: 'pr',
    kind: merged ? 'merged' : 'closed',
    subject: pr.subject,
    title: merged ? `${pr.subject} was merged` : `${pr.subject} was closed without merging`,
    body: [...closing.map(closingLine), UNLINKED].join('\n\n'),
    url: pr.url,
  }
}

const conflictInput = (pr: WatchedPr): PrInput => ({
  source: 'pr',
  kind: 'conflict',
  subject: pr.subject,
  title: `${pr.subject} has conflicts with its base branch`,
  body: 'GitHub reports the branch cannot be merged cleanly until the conflicts are resolved.',
  url: pr.url,
})

/**
 * A conflict is news once per head commit and base branch, until the PR merges cleanly again.
 * GitHub recomputes it whenever the base moves, and the same commit still conflicts after that.
 */
function newConflict(previous: PrSnapshot, pr: WatchedPr): boolean {
  if (!pr.conflicting || pr.state !== 'open') {
    return false
  }
  const now = conflictOf(pr)
  const told = previous.conflict
  if (now === undefined || told === undefined) {
    return !previous.conflicting
  }
  return now.base !== told.base || now.head !== told.head
}

function lifecycleInputs(previous: PrSnapshot, pr: WatchedPr, closing: readonly Post[], ended: boolean): PrInput[] {
  const conflict = newConflict(previous, pr) ? [conflictInput(pr)] : []
  const end = pr.state !== 'open' && previous.state === 'open' ? [stateInput(pr, closing)] : []
  return [...conflict, ...end.map((input) => quieted(input, ended ? 'own_action' : null))]
}

/**
 * The reported CI record of a commit after another look at it: with every failing check seen so
 * far, and marked while its checks run again.
 */
function nextCi(told: PrSnapshot['ci'], current: PrSnapshot['ci'], pr: WatchedPr): PrSnapshot['ci'] {
  if (told === null) {
    return null
  }
  if (told.oid !== pr.head_oid) {
    return told
  }
  if (current === null) {
    return pr.ci === 'pending' ? { ...told, rerun: true } : told
  }
  const failing =
    current.state === 'failure' ? [...new Set([...(told.failing ?? []), ...(current.failing ?? [])])] : null
  return { oid: told.oid, state: told.state, ...(failing === null ? {} : { failing }) }
}

/**
 * A new CI result, or checks that failed late on a reported commit, and the CI record to keep. A
 * pass wakes the agent after a reported failure or its own push; a rerun that ends as the commit
 * was reported before is a repeat.
 */
function ciInputs(previous: PrSnapshot, pr: WatchedPr, awaitsCi: boolean): { inputs: PrInput[]; ci: PrSnapshot['ci'] } {
  const current = finishedCi(pr)
  const told = previous.ci
  if (current === null) {
    return { inputs: [], ci: nextCi(told, current, pr) }
  }
  if (told?.oid !== current.oid || told.state !== current.state) {
    const idle = current.state === 'success' && told?.state !== 'failure' && !awaitsCi
    return { inputs: [quieted(ciInput(pr, current), idle ? 'nothing_pending' : null)], ci: current }
  }
  const late =
    current.state === 'failure' && told.failing !== undefined ? lateFailureInput(pr, current, told.failing) : null
  const again = told.rerun === true ? [quieted(ciInput(pr, current), 'repeat')] : []
  return { inputs: late === null ? again : [late], ci: nextCi(told, current, pr) }
}

/** A PR that ended under CLOSING_MS ago may still get the comment that ended it, so its end waits. */
const settling = (pr: WatchedPr, now: number) =>
  pr.state !== 'open' && pr.closed_at !== null && now < Date.parse(pr.closed_at) + CLOSING_MS

/**
 * Updates since the last snapshot for the task `reader` describes, and the next snapshot. The
 * first sighting, and a PR seen again after it ended, only set a baseline. What the reader did
 * itself, a repeat, and a pass it did not wait for are marked quiet. The end of a PR carries the
 * comments and reviews of others that came with it.
 */
export function prEvents(
  previous: PrSnapshot | undefined,
  pr: WatchedPr,
  reader: PrReader = {},
  now = Date.now(),
): { inputs: PrInput[]; next: PrSnapshot } {
  if (previous?.state !== 'open') {
    return { inputs: [], next: snapshotOf(pr, finishedCi(pr), conflictOf(pr)) }
  }
  if (settling(pr, now)) {
    return { inputs: [], next: previous }
  }
  const { inputs: ci, ci: nextCiRecord } = ciInputs(previous, pr, reader.awaitsCi ?? true)
  const all = newPosts(previous, pr)
  const own = all.filter((post) => reader.posts?.has(post.id) === true)
  const posts = all.filter((post) => !own.includes(post))
  const closing = pr.state === 'open' ? [] : closingPosts(pr, posts)
  const rest = posts.filter((post) => !closing.includes(post))
  const inputs = [
    ...ci,
    ...postInputs(pr, rest),
    ...postInputs(pr, own).map((input) => quieted(input, 'own_action')),
    ...lifecycleInputs(previous, pr, closing, reader.ended === true),
  ]
  return { inputs, next: snapshotOf(pr, nextCiRecord, pr.clean ? undefined : (conflictOf(pr) ?? previous.conflict)) }
}
