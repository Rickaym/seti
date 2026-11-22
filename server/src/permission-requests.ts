import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest, PermissionRequestKind } from '@seti/shared'
import { permissionModeOf } from './bypass-mode.js'
import { tasks } from './db.js'
import { INPUT_CHARS, isEditable } from './permission-edits.js'
import { callHash, takeGrant } from './permission-grants.js'
import { alwaysRules } from './permission-policy.js'
import { ASK_TOOL, askQuestions } from './questions.js'
import { stoppingForRestart } from './restart-state.js'
import { adapterFor, DEFAULT_RUNTIME } from './runtimes/registry.js'
import { redactSecrets, scrubValue } from './scrub.js'
import { permissionRequests, timeoutSettings } from './store/permissions.js'
import { setStall, refreshBlocked } from './task-blocked.js'
import { publish } from './task-events.js'

const SUMMARY_CHARS = 300

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text)

const firstText = (input: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((key) => input[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '')

const SUMMARY_KEYS = ['command', 'file_path', 'notebook_path', 'url', 'query', 'path', 'pattern', 'description']
const MESSAGE_KEYS = ['text', 'message', 'body', 'content', 'subject']

/** One line of what the call does, such as its command, file or URL, else its first text field. */
function summarize(tool: string, input: Record<string, unknown>): string {
  if (tool === 'ExitPlanMode') {
    return 'Approve the plan and start on it'
  }
  const text = firstText(input, [...SUMMARY_KEYS, ...MESSAGE_KEYS, ...Object.keys(input)]) ?? ''
  return clip(redactSecrets(text.replace(/\s+/g, ' ').trim()), SUMMARY_CHARS)
}

/** Sets the task's reason line from its pending requests and tells its views about the request. */
export async function announce(request: PermissionRequest): Promise<void> {
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

/** The call's input as a request shows it: secrets redacted, cut to a size the page can show. */
export function inputText(input: Record<string, unknown>): string {
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
 * early; a turn cut short or a closed session drops the request. A turn Seti's own stop cuts off
 * leaves it pending, so the user's answer still reaches the agent after the start.
 */
async function answerOf(id: string, signals: readonly AbortSignal[]): Promise<PermissionResult> {
  const signal = AbortSignal.any([...signals])
  return new Promise((resolve) => {
    const drop = () => {
      if (!waiting.delete(id)) {
        return
      }
      if (stoppingForRestart()) {
        resolve(DROPPED)
        return
      }
      dropRequest(id)
        .catch((e: unknown) => {
          process.stderr.write(`permissions: could not drop request ${id}: ${String(e)}\n`)
        })
        .finally(() => {
          resolve(DROPPED)
        })
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

/** Closes a pending request nobody waits on any more, without a word to the agent. */
export async function dropRequest(id: string): Promise<void> {
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
  always = false,
) =>
  ({
    behavior: 'allow',
    updatedInput: input,
    ...(request.tool_name === 'ExitPlanMode' ? { updatedPermissions: planDone(mode) } : {}),
    ...(always ? { decisionClassification: 'user_permanent' } : {}),
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

/** A call Seti asks the user about, why, and the rules Always allow would add. */
interface Ask {
  tool: string
  input: Record<string, unknown>
  kind: PermissionRequestKind
  reason: string | null
  suggestions: string[]
}

/** The call the user allowed after a restart cut it off runs once without a second request. */
async function allowedAlready(taskId: string, ask: Ask, hash: string): Promise<PermissionResult | null> {
  const task = takeGrant(taskId, hash) ? await tasks.get(taskId) : undefined
  return task === undefined ? null : allowed({ tool_name: ask.tool }, ask.input, permissionModeOf(task))
}

/** Records the call, shows it to the user, and waits for their answer. */
async function askUser(taskId: string, ask: Ask, signals: readonly AbortSignal[]): Promise<PermissionResult> {
  const hash = callHash(ask.tool, ask.input)
  const granted = await allowedAlready(taskId, ask, hash)
  if (granted !== null) {
    return granted
  }
  const id = randomUUID()
  inputs.set(id, ask.input)
  const answer = answerOf(id, signals)
  try {
    const request = await permissionRequests.open({
      id,
      task_id: taskId,
      tool_name: ask.tool,
      kind: ask.kind,
      summary: summarize(ask.tool, ask.input),
      input: inputText(ask.input),
      reason: ask.reason,
      suggestions: ask.suggestions,
      editable: ask.kind !== 'repeat' && rewritesInput() && isEditable(ask.tool, ask.input),
      input_hash: hash,
      timeout_minutes: (await timeoutSettings.get()).request_timeout_minutes,
    })
    if (waiting.has(id)) {
      await announce(request)
    } else if (!stoppingForRestart()) {
      await dropRequest(id)
    }
    return await answer
  } finally {
    inputs.delete(id)
    waiting.delete(id)
  }
}

/** Whether the agent's runtime runs a call with the input a decision hands back. */
const rewritesInput = () => adapterFor(DEFAULT_RUNTIME).capabilities.gate.rewriteInput

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

/** Decides each tool call Claude Code would ask about: the user answers a request or a question. */
export const canUseToolFor =
  (taskId: string, session: AbortSignal): CanUseTool =>
  async (tool, input, options) => {
    if (tool === ASK_TOOL) {
      return askQuestions(taskId, input, options, session)
    }
    const server = signInServer(tool)
    if (server !== null) {
      await setStall(taskId, 'mcp', `Sign in to the ${server} MCP server in Seti`)
      return { behavior: 'deny', message: signInMessage(server) }
    }
    const ask: Ask = {
      tool,
      input,
      kind: 'tool',
      reason: reasonOf(options),
      suggestions: alwaysRules(tool, input, options),
    }
    return askUser(taskId, ask, [options.signal, session])
  }

/** Asks the user about a call the agent repeats with the same result; it offers no rules. */
export const askAboutRepeat = async (
  taskId: string,
  call: { tool: string; input: Record<string, unknown> },
  reason: string,
  signals: readonly AbortSignal[],
): Promise<PermissionResult> => askUser(taskId, { ...call, kind: 'repeat', reason, suggestions: [] }, signals)

const REVIEW_REASON = 'A review rule holds this call for you to check, and edit, before it runs'

/** Asks the user about an MCP call a review rule holds; no rules, as review asks each time. */
export const askForReview = async (
  taskId: string,
  call: { tool: string; input: Record<string, unknown> },
  signals: readonly AbortSignal[],
): Promise<PermissionResult> =>
  askUser(taskId, { ...call, kind: 'review', reason: REVIEW_REASON, suggestions: [] }, signals)
