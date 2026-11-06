export const PERMISSION_PROMPT = 'deploy once I allow it'
export const PERMISSION_COMMAND = 'make deploy'
export const PERMISSION_DONE = 'Deployed.'

/** What Seti answers a tool call with, as far as the stand-in reads it. */
interface PermissionAnswer {
  behavior: string
  message?: string
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

export const PERMISSION_INPUT = { command: PERMISSION_COMMAND }

/** Asks Seti to run the deploy no rule allows; returns the tool result and the reply after it. */
export async function askToDeploy(
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
