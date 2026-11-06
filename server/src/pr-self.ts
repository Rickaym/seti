import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { PrPost } from './pr-events.js'
import { postsPrCommentCall, resultText, toolResults } from './pr-link.js'
import { postTargets, targetsPr, type PrTarget } from './pr-target.js'
import { prWatch, type StoredCall } from './store/pr-watch.js'

/** A call that posted a comment or review: when it ran, the PRs it named, the anchors it linked. */
export interface AgentPosting {
  at: number
  anchors: string[]
  targets: PrTarget[]
}

/** Longest a post may trail the call that made it, and how far GitHub's clock may run ahead. */
const POST_LAG_MS = 10 * 60_000
const CLOCK_SKEW_MS = 60_000

const ANCHOR = /#(issuecomment-|pullrequestreview-|discussion_r)(\d+)/g

const anchorsIn = (text: string) => [...text.matchAll(ANCHOR)].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`)

/** The posting calls among stored transcript rows, with the anchors of what their output links. */
export function agentPostings(rows: readonly StoredCall[]): AgentPosting[] {
  const calls = new Map<string, AgentPosting>()
  for (const row of rows) {
    const message = JSON.parse(row.payload) as SDKMessage
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type === 'tool_use' && postsPrCommentCall(block.name, block.input)) {
          calls.set(block.id, {
            at: Date.parse(row.created_at),
            anchors: [],
            targets: postTargets(block.name, block.input),
          })
        }
      }
    }
    for (const result of toolResults(message)) {
      calls.get(result.tool_use_id)?.anchors.push(...anchorsIn(resultText(result)))
    }
  }
  return [...calls.values()]
}

/** A call naming no PR posts on its branch's PR, which a stored call cannot tell: maybe this one. */
const mayPostOn = (posting: AgentPosting, pr: string) =>
  posting.targets.length === 0 || posting.targets.some((target) => targetsPr(target, pr))

/**
 * Ids of the posts on the PR at `pr` the agents wrote: those a posting call's output links, and
 * for each call on that PR whose output links none, the first post by the gh user soon after it,
 * as agents post as them.
 */
export function ownPosts(
  posts: readonly PrPost[],
  postings: readonly AgentPosting[],
  viewer: string,
  pr: string,
): Set<string> {
  const linked = new Set(postings.flatMap((posting) => posting.anchors))
  const own = new Set(
    posts
      .filter((post) => [post.url, ...post.inline].some((url) => anchorsIn(url).some((a) => linked.has(a))))
      .map((post) => post.id),
  )
  const byViewer = posts
    .filter((post) => post.at !== null && post.login?.toLowerCase() === viewer.toLowerCase())
    .map((post) => ({ id: post.id, at: Date.parse(post.at ?? '') }))
    .toSorted((a, b) => a.at - b.at)
  const unlinked = postings
    .filter((posting) => posting.anchors.length === 0 && mayPostOn(posting, pr))
    .toSorted((a, b) => a.at - b.at)
  for (const call of unlinked) {
    const claimed = byViewer.find(
      (post) => !own.has(post.id) && post.at >= call.at - CLOCK_SKEW_MS && post.at <= call.at + POST_LAG_MS,
    )
    if (claimed !== undefined) {
      own.add(claimed.id)
    }
  }
  return own
}

/** When the calls that could have made these posts ran, or null when no post has a time. */
export function callWindow(posts: readonly PrPost[]): { from: string; to: string } | null {
  const times = posts.flatMap((post) => (post.at === null ? [] : [Date.parse(post.at)])).filter(Number.isFinite)
  if (times.length === 0) {
    return null
  }
  return {
    from: new Date(Math.min(...times) - POST_LAG_MS).toISOString(),
    to: new Date(Math.max(...times) + POST_LAG_MS).toISOString(),
  }
}

/** Ids of the new posts on a PR that the agents linked to it wrote. */
export async function agentPosts(url: string, posts: readonly PrPost[], viewer: string): Promise<Set<string>> {
  const window = callWindow(posts)
  if (window === null) {
    return new Set()
  }
  return ownPosts(posts, agentPostings(await prWatch.calls(url, window.from, window.to)), viewer, url)
}
