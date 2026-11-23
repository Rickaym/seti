import { type ToolCall, payloadEvents } from '@seti/shared'
import type { WatchedPr } from './github.js'
import { shellCommand } from './outward.js'
import type { PrPost } from './pr-events.js'
import { pushTargets } from './pr-evidence.js'
import { createsPrCall, endsPrCall, postsPrCommentCall } from './pr-link.js'
import { postTargets, targetsPr, type PrTarget } from './pr-target.js'
import { prWatch, type StoredCall } from './store/pr-watch.js'

/** A call that acted on a PR: whose it was, when it ran, the PRs it named, the anchors it linked. */
export interface AgentCall {
  task_id: string
  at: number
  /** When its result came back; null while it runs. */
  until: number | null
  anchors: string[]
  targets: PrTarget[]
}

/** Longest a call's effect may trail its start while it runs, and how far clocks may differ. */
const POST_LAG_MS = 10 * 60_000
const CLOCK_SKEW_MS = 5_000

const ANCHOR = /#(issuecomment-|pullrequestreview-|discussion_r)(\d+)/g

const anchorsIn = (text: string) => [...text.matchAll(ANCHOR)].map((match) => `${match[1] ?? ''}${match[2] ?? ''}`)

type Acts = (call: ToolCall) => boolean

/** The calls among stored transcript rows that `acts` picks, with the anchors their output links. */
function agentCalls(rows: readonly StoredCall[], acts: Acts): AgentCall[] {
  const calls = new Map<string, AgentCall>()
  for (const row of rows) {
    const at = Date.parse(row.created_at)
    for (const event of payloadEvents(row.payload)) {
      if (event.type === 'tool.started' && acts(event.call)) {
        const targets = postTargets(event.call)
        calls.set(event.call.callId, { task_id: row.task_id, at, until: null, anchors: [], targets })
      }
      const call = event.type === 'tool.ended' ? calls.get(event.callId) : undefined
      if (event.type === 'tool.ended' && call !== undefined) {
        call.until = at
        call.anchors.push(...anchorsIn(event.result.text))
      }
    }
  }
  return [...calls.values()]
}

/** The calls that posted a comment or review. */
export const agentPostings = (rows: readonly StoredCall[]) => agentCalls(rows, postsPrCommentCall)

/** A call naming no PR acts on its branch's PR, which a stored call cannot tell: maybe this one. */
const mayActOn = (call: AgentCall, pr: string) =>
  call.targets.length === 0 || call.targets.some((target) => targetsPr(target, pr))

/** Whether something GitHub timed at `at` happened while the call ran, clocks allowed for. */
const duringCall = (call: AgentCall, at: number) =>
  at >= call.at - CLOCK_SKEW_MS && at <= (call.until ?? call.at + POST_LAG_MS) + CLOCK_SKEW_MS

/**
 * The posts on the PR at `pr` that agents wrote, each with the task that wrote it: those a
 * posting call's output links, and the posts by the gh user made while a call on that PR ran
 * whose output links none, as agents post as them.
 */
export function ownPosts(
  posts: readonly PrPost[],
  postings: readonly AgentCall[],
  viewer: string,
  pr: string,
): Map<string, string> {
  const linked = new Map(postings.flatMap((posting) => posting.anchors.map((anchor) => [anchor, posting.task_id])))
  const own = new Map<string, string>()
  for (const post of posts) {
    const anchor = [post.url, ...post.inline].flatMap(anchorsIn).find((found) => linked.has(found))
    const taskId = anchor === undefined ? undefined : linked.get(anchor)
    if (taskId !== undefined) {
      own.set(post.id, taskId)
    }
  }
  const unlinked = postings.filter((posting) => posting.anchors.length === 0 && mayActOn(posting, pr))
  for (const post of posts) {
    const at = post.at === null ? Number.NaN : Date.parse(post.at)
    const byViewer = post.login?.toLowerCase() === viewer.toLowerCase()
    const call = byViewer && !own.has(post.id) ? unlinked.find((posting) => duringCall(posting, at)) : undefined
    if (call !== undefined) {
      own.set(post.id, call.task_id)
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

/** The new posts on a PR that the agents linked to it wrote, by post id with the writing task. */
export async function agentPosts(url: string, posts: readonly PrPost[], viewer: string): Promise<Map<string, string>> {
  const window = callWindow(posts)
  if (window === null) {
    return new Map()
  }
  return ownPosts(posts, agentPostings(await prWatch.calls(url, window.from, window.to)), viewer, url)
}

/** The tasks whose merge or close call on the PR at `pr` ran when GitHub says it ended. */
export function endedBy(rows: readonly StoredCall[], pr: string, closedAt: number): Set<string> {
  const calls = agentCalls(rows, endsPrCall).filter((call) => mayActOn(call, pr) && duringCall(call, closedAt))
  return new Set(calls.map((call) => call.task_id))
}

/** The tasks linked to a PR that merged or closed it themselves. */
export async function agentEnders(pr: WatchedPr): Promise<Set<string>> {
  const closedAt = pr.closed_at === null ? Number.NaN : Date.parse(pr.closed_at)
  if (!Number.isFinite(closedAt)) {
    return new Set()
  }
  const from = new Date(closedAt - POST_LAG_MS - CLOCK_SKEW_MS).toISOString()
  const to = new Date(closedAt + CLOCK_SKEW_MS).toISOString()
  return endedBy(await prWatch.calls(pr.url, from, to), pr.url, closedAt)
}

const MCP_PUSH = /(?:^|__)(?:push_files|create_or_update_file)$/i

const pushesCall = (call: ToolCall): boolean =>
  createsPrCall(call) ||
  (call.shell?.action === 'run' ? pushTargets(shellCommand(call)) !== null : MCP_PUSH.test(call.mcp?.tool ?? ''))

/** Whether any of the stored calls pushed commits or opened a PR. */
export const pushed = (rows: readonly StoredCall[]): boolean =>
  rows.some((row) =>
    payloadEvents(row.payload).some((event) => event.type === 'tool.started' && pushesCall(event.call)),
  )

/**
 * Whether the task has a CI result to wait for on the PR: it pushed or opened a PR since Seti
 * last gave it a CI result for this one.
 */
export const awaitsCi = async (taskId: string, pr: WatchedPr): Promise<boolean> =>
  pushed(await prWatch.pushCalls(taskId, pr.subject))
