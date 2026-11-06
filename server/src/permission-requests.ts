import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest } from '@seti/shared'
import { audit } from './audit.js'
import { alwaysRules } from './permission-policy.js'
import { redactSecrets, scrubValue } from './scrub.js'
import { permissionRequests } from './store/permissions.js'
import { setStall, refreshBlocked } from './task-blocked.js'
import { publish } from './task-events.js'

/** Claude Code's tool for asking the user to pick between options, which Seti shows as text. */
const ASK_TOOL = 'AskUserQuestion'

const ASK_IN_TEXT =
  'Seti shows no question dialog. Write the question and its options as your reply and end your ' +
  'turn; the user answers in the chat.'

const SUMMARY_CHARS = 300
const INPUT_CHARS = 8000

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

const firstText = (input: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((key) => input[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')

const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern', 'description']

/** One line of what the call does, such as its command, file or URL. */
function summarize(tool: string, input: Record<string, unknown>): string {
  if (tool === 'ExitPlanMode') {
    return 'Approve the plan and start on it'
  }
  const text = firstText(input, SUMMARY_KEYS) ?? ''
  return clip(redactSecrets(text.replace(/\s+/g, ' ').trim()), SUMMARY_CHARS)
}

/** Sets the task's reason line from its pending requests and tells its views about the request. */
async function announce(request: PermissionRequest): Promise<void> {
  publish(request.task_id, { type: 'permission', request, blocked: await refreshBlocked(request.task_id) })
}

/** Answers waiting for the user, by request id; each resolves the agent's tool call. */
const waiting = new Map<string, (result: PermissionResult) => void>()

/** Whether a running session still waits on the request. */
export const waitsFor = (requestId: string) => waiting.has(requestId)

/** Hands the agent the user's answer; false when no session waits on it any more. */
export async function resolveRequest(request: PermissionRequest, result: PermissionResult): Promise<boolean> {
  const resolve = waiting.get(request.id)
  waiting.delete(request.id)
  await announce(request)
  resolve?.(result)
  return resolve !== undefined
}

function inputText(input: Record<string, unknown>): string {
  return clip(JSON.stringify(scrubValue(input), null, 2), INPUT_CHARS)
}

type AskOptions = Parameters<CanUseTool>[2]

function reasonOf(options: AskOptions): string | null {
  const reason = options.decisionReason ?? options.description ?? options.title ?? null
  const blocked = options.blockedPath === undefined ? '' : `Path: ${options.blockedPath}`
  const text = [reason ?? '', blocked].filter((part) => part !== '').join('. ')
  return text === '' ? null : redactSecrets(text)
}

const DROPPED: PermissionResult = { behavior: 'deny', message: 'The request was dropped.', interrupt: true }

/**
 * Waits for the user's answer to the request, from before it is recorded so no answer comes too
 * early; a turn cut short or a closed session drops the request.
 */
async function answerOf(id: string, signals: readonly AbortSignal[]): Promise<PermissionResult> {
  const signal = AbortSignal.any([...signals])
  return new Promise((resolve) => {
    const drop = () => {
      if (waiting.delete(id)) {
        dropRequest(id)
          .catch((e: unknown) => {
            process.stderr.write(`permissions: could not drop request ${id}: ${String(e)}\n`)
          })
          .finally(() => {
            resolve(DROPPED)
          })
      }
    }
    waiting.set(id, (result) => {
      signal.removeEventListener('abort', drop)
      resolve(result)
    })
    if (signal.aborted) {
      drop()
    } else {
      signal.addEventListener('abort', drop, { once: true })
    }
  })
}

async function dropRequest(id: string): Promise<void> {
  const settled = await permissionRequests.settle(id, 'cancelled', null)
  if (settled !== undefined) {
    await announce(settled)
  }
}

/** A plan the user approved leaves plan mode for the agent's mode, bypass while its Bypass lasts. */
const planDone = (mode: PermissionMode): PermissionUpdate[] => [{ type: 'setMode', mode, destination: 'session' }]

/** What the agent gets for an allowed call; an approved plan goes on in `mode`. */
export const allowed = (
  request: Pick<PermissionRequest, 'tool_name'>,
  input: Record<string, unknown>,
  mode: PermissionMode,
) =>
  ({
    behavior: 'allow',
    updatedInput: input,
    ...(request.tool_name === 'ExitPlanMode' ? { updatedPermissions: planDone(mode) } : {}),
  }) satisfies PermissionResult

/** What the agent gets for a denied call, with the user's words when they gave any. */
export const denied = (message: string | null): PermissionResult => ({
  behavior: 'deny',
  message:
    message === null || message === ''
      ? 'The user denied this tool call. Do not retry it; ask the user how to go on if you need it.'
      : `The user denied this tool call and said: ${message}`,
})

/** The input of each waiting call, which an allow hands back to Claude Code unchanged. */
const inputs = new Map<string, Record<string, unknown>>()

export const waitingInput = (requestId: string): Record<string, unknown> => inputs.get(requestId) ?? {}

/** Records the call, shows it to the user, and waits for their answer. */
async function askUser(
  taskId: string,
  call: { tool: string; input: Record<string, unknown> },
  options: AskOptions,
  session: AbortSignal,
): Promise<PermissionResult> {
  const id = randomUUID()
  inputs.set(id, call.input)
  const answer = answerOf(id, [options.signal, session])
  try {
    const request = await permissionRequests.open({
      id,
      task_id: taskId,
      tool_name: call.tool,
      summary: summarize(call.tool, call.input),
      input: inputText(call.input),
      reason: reasonOf(options),
      suggestions: alwaysRules(call.tool, call.input, options),
    })
    await (waiting.has(id) ? announce(request) : dropRequest(id))
    return await answer
  } finally {
    inputs.delete(id)
    waiting.delete(id)
  }
}

/** Claude Code's stand-in tools of an MCP server that needs a sign-in; Seti signs in instead. */
const SIGN_IN_TOOLS = ['authenticate', 'complete_authentication']

/** The server whose sign-in the tool starts, or null for any other tool. */
function signInServer(tool: string): string | null {
  const [prefix, server, ...rest] = tool.split('__')
  return prefix === 'mcp' && server !== undefined && SIGN_IN_TOOLS.includes(rest.join('__')) ? server : null
}

const signInMessage = (server: string) =>
  `The ${server} MCP server needs a sign-in, which only the user does, in Seti under Settings, MCP ` +
  'servers. Tell the user, carry on without it where you can, and end your turn if you cannot.'

/** Decides each tool call Claude Code would ask about: the user does, through a request. */
export const canUseToolFor =
  (taskId: string, session: AbortSignal): CanUseTool =>
  async (tool, input, options) => {
    if (tool === ASK_TOOL) {
      return { behavior: 'deny', message: ASK_IN_TEXT }
    }
    const server = signInServer(tool)
    if (server !== null) {
      await setStall(taskId, 'mcp', `Sign in to the ${server} MCP server in Seti`)
      return { behavior: 'deny', message: signInMessage(server) }
    }
    return askUser(taskId, { tool, input }, options, session)
  }

/** No process waits on a request a restart left pending; startup drops them. */
export async function dropLeftoverRequests(): Promise<void> {
  const dropped = await permissionRequests.cancelAll()
  if (dropped.length > 0) {
    await audit.record({
      actor: 'system',
      kind: 'task.permission_denied',
      subject_type: 'system',
      summary: `Dropped ${String(dropped.length)} permission requests a restart cut off`,
      detail: { requests: dropped.length },
    })
  }
}
