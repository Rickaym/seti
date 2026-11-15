import { randomUUID } from 'node:crypto'
import type { StepActor } from './fake-steps.js'

export const PERMISSION_PROMPT = 'deploy once I allow it'
export const PERMISSION_COMMAND = 'make deploy'
export const PERMISSION_DONE = 'Deployed.'
export const PLAN_APPROVAL_PROMPT = 'show my plan for approval'
export const PLAN_TEXT = 'Read the failing test, fix the parser, then run the suite.'
export const PLAN_STARTED = 'Starting on the plan.'

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

/**
 * Asks Seti to run a command no rule allows, or to approve its plan when the prompt asks for
 * one, then goes on or says why it did not.
 */
export async function actPermission(
  canUseTool: CanUseTool | undefined,
  actor: StepActor,
  prompt: string,
): Promise<void> {
  const plan = prompt.includes(PLAN_APPROVAL_PROMPT)
  const id = `toolu_perm_${randomUUID().slice(0, 8)}`
  actor.assistant([
    {
      type: 'tool_use',
      id,
      name: plan ? 'ExitPlanMode' : 'Bash',
      input: plan ? { plan: PLAN_TEXT } : PERMISSION_INPUT,
    },
  ])
  const { result, reply } = await (plan ? askToStart(canUseTool, id) : askToDeploy(canUseTool, id))
  if (!actor.ended()) {
    actor.toolResult(id, result)
    actor.assistant([{ type: 'text', text: reply }])
  }
}
