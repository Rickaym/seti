import { randomUUID } from 'node:crypto'
import type { StepActor } from './fake-steps.js'

export const PERMISSION_PROMPT = 'deploy once I allow it'
export const PERMISSION_COMMAND = 'make deploy'
export const PERMISSION_DONE = 'Deployed.'

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

/** Asks Seti to run a command no rule allows, then runs it or says why it did not. */
export async function actPermission(canUseTool: CanUseTool | undefined, actor: StepActor): Promise<void> {
  const id = `toolu_perm_${randomUUID().slice(0, 8)}`
  actor.assistant([{ type: 'tool_use', id, name: 'Bash', input: PERMISSION_INPUT }])
  const { result, reply } = await askToDeploy(canUseTool, id)
  if (!actor.ended()) {
    actor.toolResult(id, result)
    actor.assistant([{ type: 'text', text: reply }])
  }
}
