import { findPrUrls, type RuntimeEvent, type ToolCall } from '@seti/shared'
import { isOutward, shellCommand } from './outward.js'

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/
const GH_API_PULLS = /\bgh\s+api\b[^\n|;&]*\brepos\/[\w.-]+\/[\w.-]+\/pulls(?![\w/])/
const SENDS_FIELDS = /(?:-X|--method)[\s=]*POST\b|\s(?:-f|-F|--field|--raw-field|--input)[\s=]/i
const READS_ONLY = /(?:-X|--method)[\s=]*GET\b/i

/** `gh pr create`, or a `gh api` POST to a repo pulls endpoint (gh POSTs when given fields). */
export function createsPr(command: string): boolean {
  if (GH_PR_CREATE.test(command)) {
    return true
  }
  return GH_API_PULLS.test(command) && SENDS_FIELDS.test(command) && !READS_ONLY.test(command)
}

const MCP_CREATE_PR = /(?:^|__)create_pull_request$/i

const GH_COMMENT = /\bgh\s+(?:pr|issue)\s+(?:comment|review)\b/
const GH_API_COMMENTS = /\bgh\s+api\b[^\n|;&]*\b(?:comments|reviews|replies)\b/
const COMMENT_TOOL = /comment|review/i
const GH_GRAPHQL = /\bgh\s+api\s+graphql\b/
const GRAPHQL_POST = /\b(?:addComment|addPullRequestReview\w*|submitPullRequestReview)\b/

/** The MCP tool a call names, or null for a call of another kind. */
const mcpTool = (call: ToolCall): string | null => call.mcp?.tool ?? null

const isShell = (call: ToolCall): boolean => call.shell?.action === 'run'

/** A tool call that may post a comment or review on a PR, by gh or a GitHub MCP server. */
export function postsPrCommentCall(call: ToolCall): boolean {
  if (!isShell(call)) {
    return COMMENT_TOOL.test(mcpTool(call)?.split('__').at(-1) ?? '') && isOutward(call)
  }
  const command = shellCommand(call)
  if (GH_COMMENT.test(command)) {
    return true
  }
  if (GH_GRAPHQL.test(command)) {
    return GRAPHQL_POST.test(command)
  }
  return GH_API_COMMENTS.test(command) && SENDS_FIELDS.test(command) && !READS_ONLY.test(command)
}

const GH_END = /\bgh\s+pr\s+(?:merge|close)\b/
const GH_API_PULL = /\bgh\s+api\b[^\n|;&]*\/pulls\/\d+(\/merge\b)?/
const CLOSES = /\bstate=closed\b/
const GRAPHQL_END = /\b(?:mergePullRequest|closePullRequest)\b/
const END_TOOL = /(?:^|__)(?:merge_pull_request|close_pull_request)$/i
const UPDATE_TOOL = /(?:^|__)update_pull_request$/i

const closesByField = (input: unknown) =>
  typeof input === 'object' && input !== null && 'state' in input && input.state === 'closed'

/** A tool call that may merge or close a PR, by gh or a GitHub MCP server. */
export function endsPrCall(call: ToolCall): boolean {
  if (!isShell(call)) {
    const tool = mcpTool(call) ?? ''
    return END_TOOL.test(tool) || (UPDATE_TOOL.test(tool) && closesByField(call.input))
  }
  const command = shellCommand(call)
  if (GH_GRAPHQL.test(command)) {
    return GRAPHQL_END.test(command)
  }
  const pull = GH_API_PULL.exec(command)
  const ends = pull !== null && (pull[1] !== undefined || CLOSES.test(command))
  return GH_END.test(command) || (ends && !READS_ONLY.test(command))
}

/** A tool call that opens a PR: a PR-creating shell command or a GitHub MCP create_pull_request. */
export function createsPrCall(call: ToolCall): boolean {
  return isShell(call) ? createsPr(shellCommand(call)) : MCP_CREATE_PR.test(mcpTool(call) ?? '')
}

/** A PR a tool call reported, and the subagent call it ran under; null for the task's own agent. */
export interface CreatedPr {
  url: string
  parent: string | null
}

/** Tracks PR-creating calls per task and yields every PR URL their output reports, failed or not. */
export function createPrWatcher() {
  const pending = new Map<string, Map<string, string | null>>()

  return (taskId: string, events: readonly RuntimeEvent[]): CreatedPr[] => {
    const calls = pending.get(taskId) ?? new Map<string, string | null>()
    pending.set(taskId, calls)
    const created = new Map<string, string | null>()
    for (const event of events) {
      if (event.type === 'tool.started' && createsPrCall(event.call)) {
        calls.set(event.call.callId, event.thread === '' ? null : event.thread)
      }
      if (event.type !== 'tool.ended' || !calls.has(event.callId)) {
        continue
      }
      const parent = calls.get(event.callId) ?? null
      calls.delete(event.callId)
      for (const url of findPrUrls(event.result.text).filter((found) => !created.has(found))) {
        created.set(url, parent)
      }
    }
    return [...created].map(([url, from]) => ({ url, parent: from }))
  }
}
