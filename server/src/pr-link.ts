import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { findPrUrls } from '@seti/shared'
import { bashCommand, isOutward } from './outward.js'

type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResult = Extract<UserBlock, { type: 'tool_result' }>

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

/** A tool call that may post a comment or review on a PR, by gh or a GitHub MCP server. */
export function postsPrCommentCall(name: string, input: unknown): boolean {
  if (name !== 'Bash') {
    return COMMENT_TOOL.test(name.split('__').at(-1) ?? '') && isOutward(name, input)
  }
  const command = bashCommand(input)
  if (GH_COMMENT.test(command)) {
    return true
  }
  if (GH_GRAPHQL.test(command)) {
    return GRAPHQL_POST.test(command)
  }
  return GH_API_COMMENTS.test(command) && SENDS_FIELDS.test(command) && !READS_ONLY.test(command)
}

/** A tool call that opens a PR: a PR-creating Bash command or a GitHub MCP create_pull_request. */
export function createsPrCall(name: string, input: unknown): boolean {
  return name === 'Bash' ? createsPr(bashCommand(input)) : MCP_CREATE_PR.test(name)
}

function prCreateCalls(m: SDKMessage): string[] {
  if (m.type !== 'assistant') {
    return []
  }
  return m.message.content.flatMap((block) =>
    block.type === 'tool_use' && createsPrCall(block.name, block.input) ? [block.id] : [],
  )
}

export function toolResults(m: SDKMessage): ToolResult[] {
  if (m.type !== 'user' || typeof m.message.content === 'string') {
    return []
  }
  return m.message.content.filter((block): block is ToolResult => block.type === 'tool_result')
}

export function resultText(result: ToolResult): string {
  if (typeof result.content === 'string') {
    return result.content
  }
  return (result.content ?? []).map((part) => (part.type === 'text' ? part.text : '')).join('\n')
}

/** A PR a tool call reported, and the subagent call it ran under; null for the task's own agent. */
export interface CreatedPr {
  url: string
  parent: string | null
}

/** Tracks PR-creating calls per task and yields every PR URL their output reports, failed or not. */
export function createPrWatcher() {
  const pending = new Map<string, Map<string, string | null>>()

  return (taskId: string, m: SDKMessage): CreatedPr[] => {
    const calls = pending.get(taskId) ?? new Map<string, string | null>()
    for (const id of prCreateCalls(m)) {
      calls.set(id, m.type === 'assistant' ? m.parent_tool_use_id : null)
    }
    pending.set(taskId, calls)
    const created = new Map<string, string | null>()
    for (const result of toolResults(m)) {
      if (!calls.has(result.tool_use_id)) {
        continue
      }
      const parent = calls.get(result.tool_use_id) ?? null
      calls.delete(result.tool_use_id)
      for (const url of findPrUrls(resultText(result)).filter((found) => !created.has(found))) {
        created.set(url, parent)
      }
    }
    return [...created].map(([url, from]) => ({ url, parent: from }))
  }
}
