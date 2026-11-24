import { randomUUID } from 'node:crypto'
import type { StepActor } from './fake-steps.js'

export const PERMISSION_PROMPT = 'deploy once I allow it'
export const PERMISSION_COMMAND = 'make deploy'
export const PERMISSION_DONE = 'Deployed.'
export const PLAN_APPROVAL_PROMPT = 'show my plan for approval'
export const PLAN_TEXT = 'Read the failing test, fix the parser, then run the suite.'
export const PLAN_STARTED = 'Starting on the plan.'
export const SLACK_PROMPT = 'post the deploy note to Slack once I allow it'
export const SLACK_CHANNEL = 'C0E2EDEPLOY'
export const SLACK_POSTED = 'Posted the deploy note.'
const SLACK_SEND = 'mcp__plugin_slack_slack__slack_send_message'
const SLACK_INPUT = { channel_id: SLACK_CHANNEL, message: 'Deploy done' }

/** What Seti answers a tool call with, as far as the stand-in reads it. */
interface PermissionAnswer {
  behavior: string
  message?: string
  updatedInput?: Record<string, unknown>
}

export type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal
    toolUseID: string
    requestId: string
    decisionReason?: string
    suggestions?: unknown[]
  },
) => Promise<PermissionAnswer | null>

const PERMISSION_INPUT = { command: PERMISSION_COMMAND }

/** Asks Seti to run the deploy no rule allows; returns the tool result and the reply after it. */
async function askToDeploy(
  canUseTool: CanUseTool | undefined,
  toolUseId: string,
): Promise<{ result: string; reply: string }> {
  const answer = await canUseTool?.('Bash', PERMISSION_INPUT, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
    decisionReason: 'No rule allows this command',
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: `${PERMISSION_COMMAND}:*` }],
      },
    ],
  })
  if (answer?.behavior === 'allow') {
    return { result: 'ok', reply: PERMISSION_DONE }
  }
  const why = answer?.message ?? 'No permission callback'
  return { result: why, reply: `Did not deploy: ${why}` }
}

/** Asks Seti to post to Slack; on a yes, answers as the Slack MCP server does, with a link. */
async function askToPost(
  canUseTool: CanUseTool | undefined,
  toolUseId: string,
): Promise<{ result: string; reply: string }> {
  const answer = await canUseTool?.(SLACK_SEND, SLACK_INPUT, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
  })
  if (answer?.behavior === 'allow') {
    const link = `https://acme.slack.com/archives/${SLACK_CHANNEL}/p1700000000000100`
    return { result: JSON.stringify({ message_link: link }), reply: SLACK_POSTED }
  }
  const why = answer?.message ?? 'No permission callback'
  return { result: why, reply: `Did not post: ${why}` }
}

/** Asks Seti to approve a plan through ExitPlanMode; returns the tool result and the reply. */
async function askToStart(
  canUseTool: CanUseTool | undefined,
  toolUseId: string,
): Promise<{ result: string; reply: string }> {
  const answer = await canUseTool?.(
    'ExitPlanMode',
    { plan: PLAN_TEXT },
    {
      signal: new AbortController().signal,
      toolUseID: toolUseId,
      requestId: `req_${toolUseId}`,
    },
  )
  if (answer?.behavior === 'allow') {
    return { result: 'approved', reply: PLAN_STARTED }
  }
  const why = answer?.message ?? 'No permission callback'
  return { result: why, reply: `Not starting: ${why}` }
}

const DEPLOY = { prompt: PERMISSION_PROMPT, tool: 'Bash', input: PERMISSION_INPUT, run: askToDeploy }
const asks = [
  { prompt: PLAN_APPROVAL_PROMPT, tool: 'ExitPlanMode', input: { plan: PLAN_TEXT }, run: askToStart },
  { prompt: SLACK_PROMPT, tool: SLACK_SEND, input: SLACK_INPUT, run: askToPost },
]

/**
 * Asks Seti to run a command no rule allows, to approve its plan, or to post to Slack, as the
 * prompt asks, then goes on or says why it did not.
 */
export async function actPermission(
  canUseTool: CanUseTool | undefined,
  actor: StepActor,
  prompt: string,
): Promise<void> {
  const id = `toolu_perm_${randomUUID().slice(0, 8)}`
  const ask = asks.find((entry) => prompt.includes(entry.prompt)) ?? DEPLOY
  actor.assistant([{ type: 'tool_use', id, name: ask.tool, input: ask.input }])
  const { result, reply } = await ask.run(canUseTool, id)
  if (!actor.ended()) {
    actor.toolResult(id, result)
    actor.assistant([{ type: 'text', text: reply }])
  }
}
