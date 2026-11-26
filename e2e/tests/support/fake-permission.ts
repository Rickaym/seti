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
/** A channel Seti never saw named; a prompt naming a channel posts there, `cc U0...` mentions one. */
export const SLACK_UNNAMED_CHANNEL = 'C0E2EUNNAMED'
const CHANNEL_ID = /\bC0[A-Z0-9]{8,}\b/
const PERSON_ID = /\bcc (U0[A-Z0-9]{8,})\b/
const slackInput = (prompt: string) => {
  const cc = PERSON_ID.exec(prompt)?.[1]
  return {
    channel_id: CHANNEL_ID.exec(prompt)?.[0] ?? SLACK_CHANNEL,
    message: cc === undefined ? 'Deploy done' : `Deploy done, cc <@${cc}>`,
  }
}
/** Asks for a channel search whose answer names the channel id in the prompt `as #name`. */
export const SLACK_LOOKUP_PROMPT = 'look up the Slack channel'
const SLACK_SEARCH = 'mcp__plugin_slack_slack__slack_search_channels'
const lookUpInput = (prompt: string) => ({
  query: `${/ as #(\S+)/.exec(prompt)?.[1] ?? ''} ${slackInput(prompt).channel_id}`,
})

/** Answers a channel search as the Slack MCP server does; no permission is asked. */
async function searchChannels(
  _canUseTool: CanUseTool | undefined,
  _toolUseId: string,
  input: Record<string, unknown>,
): Promise<{ result: string; reply: string }> {
  const [name = '', id = ''] = String(input.query).split(' ')
  const results = [
    `# Search Results for: ${name}`,
    '',
    '## Channels (1 results)',
    '### Result 1 of 1',
    `Name: #${name}`,
    'Creator: Dana Reyes (<@U0E2EDANA01>)',
    'Created: 2025-01-15 09:30:00 +0000',
    `Permalink: [link](https://acme.slack.com/archives/${id})`,
    'Is Archived: false',
    'Channel Type: public_channel',
  ].join('\n')
  return Promise.resolve({
    result: JSON.stringify({ results, pagination_info: 'End of results.' }),
    reply: 'Found it.',
  })
}

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
    description?: string
    suggestions?: unknown[]
  },
) => Promise<PermissionAnswer | null>

const PERMISSION_INPUT = { command: PERMISSION_COMMAND }

/** Asks to run the command that follows it in the prompt, with the description after it. */
export const COMMAND_PROMPT = 'run this once I allow it:'
/** Splits the command from the description the agent gives it, written after ` ## `. */
export const DESCRIPTION_MARK = ' ## '
const commandInput = (prompt: string) => {
  const [command = '', description] = prompt
    .slice(prompt.indexOf(COMMAND_PROMPT) + COMMAND_PROMPT.length)
    .split(DESCRIPTION_MARK)
  return description === undefined ? { command: command.trim() } : { command: command.trim(), description }
}

/** The rule Claude Code offers: a prefix for the deploy, the exact line for any other command. */
const ruleFor = (command: string) => (command === PERMISSION_COMMAND ? `${command}:*` : command)

/** Asks Seti to run a command no rule allows; returns the tool result and the reply after it. */
async function askToRun(
  canUseTool: CanUseTool | undefined,
  toolUseId: string,
  input: Record<string, unknown>,
): Promise<{ result: string; reply: string }> {
  const command = String(input.command)
  const described = typeof input.description === 'string' ? input.description : undefined
  const answer = await canUseTool?.('Bash', input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
    ...(described === undefined ? { decisionReason: 'No rule allows this command' } : { description: described }),
    suggestions: [
      {
        type: 'addRules',
        behavior: 'allow',
        destination: 'localSettings',
        rules: [{ toolName: 'Bash', ruleContent: ruleFor(command) }],
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
  input: Record<string, unknown>,
): Promise<{ result: string; reply: string }> {
  const answer = await canUseTool?.(SLACK_SEND, input, {
    signal: new AbortController().signal,
    toolUseID: toolUseId,
    requestId: `req_${toolUseId}`,
  })
  if (answer?.behavior === 'allow') {
    const link = `https://acme.slack.com/archives/${String(input.channel_id)}/p1700000000000100`
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

/** A permission the stand-in asks for: the prompt that asks it, the call, and how it goes on. */
interface Ask {
  prompt: string
  tool: string
  input: (prompt: string) => Record<string, unknown>
  run: (
    canUseTool: CanUseTool | undefined,
    toolUseId: string,
    input: Record<string, unknown>,
  ) => Promise<{ result: string; reply: string }>
}

const DEPLOY: Ask = { prompt: PERMISSION_PROMPT, tool: 'Bash', input: () => PERMISSION_INPUT, run: askToRun }
const asks: Ask[] = [
  { prompt: COMMAND_PROMPT, tool: 'Bash', input: commandInput, run: askToRun },
  { prompt: PLAN_APPROVAL_PROMPT, tool: 'ExitPlanMode', input: () => ({ plan: PLAN_TEXT }), run: askToStart },
  { prompt: SLACK_PROMPT, tool: SLACK_SEND, input: slackInput, run: askToPost },
  { prompt: SLACK_LOOKUP_PROMPT, tool: SLACK_SEARCH, input: lookUpInput, run: searchChannels },
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
  const ask: Ask = asks.find((entry) => prompt.includes(entry.prompt)) ?? DEPLOY
  const input = ask.input(prompt)
  actor.assistant([{ type: 'tool_use', id, name: ask.tool, input }])
  const { result, reply } = await ask.run(canUseTool, id, input)
  if (!actor.ended()) {
    actor.toolResult(id, result)
    actor.assistant([{ type: 'text', text: reply }])
  }
}
