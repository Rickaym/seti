import { randomUUID } from 'node:crypto'
import type { CanUseTool, PermissionMode, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { PermissionRequest, PermissionRequestKind } from '@seti/shared'
import { permissionModeOf } from './bypass-mode.js'
import { tasks } from './db.js'
import { editedDenial, type EditedValues } from './edit-notes.js'
import { askBeingAnswered } from './node-link.js'
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

/** The user's answer, and what the agent is told beside the call's result when they edited it. */
export interface Answer {
  result: PermissionResult
  note?: string
}

/** Answers waiting for the user, by request id; each resolves the agent's tool call. */
const waiting = new Map<string, (answer: Answer) => void>()

/** Whether a running session still waits on the request. */
export const waitsFor = (requestId: string) => waiting.has(requestId)

/** Hands the agent the user's answer, and any note of their edits; false when no session waits. */
export async function resolveRequest(request: PermissionRequest, result: PermissionResult, note?: string) {
  const resolve = waiting.get(request.id)
  waiting.delete(request.id)
  await announce(request)
  resolve?.(note === undefined ? { result } : { result, note })
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

const DROPPED: Answer = { result: { behavior: 'deny', message: 'The request was dropped.', interrupt: true } }

/**
 * Waits for the user's answer to the request, from before it is recorded so no answer comes too
 * early; a turn cut short or a closed session drops the request. A turn Seti's own stop cuts off
 * leaves it pending, so the user's answer still reaches the agent after the start.
 */
async function answerOf(id: string, signals: readonly AbortSignal[]): Promise<Answer> {
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
    waiting.set(id, (answer) => {
      signal.removeEventListener('abort', drop)
      resolve(answer)
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

/** What the agent gets for a denied call, with the user's words and edits when they gave any. */
export const denied = (message: string | null, edited: EditedValues = {}): PermissionResult => {
  if (Object.keys(edited).length > 0) {
    return { behavior: 'deny', message: editedDenial(edited, message) }
  }
  return {
    behavior: 'deny',
    message:
      message === null || message === ''
        ? 'The user denied this tool call. Do not retry it; ask the user how to go on if you need it.'
        : `The user denied this tool call and said: ${message}`,
  }
}

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
  /** Whether the agent's runtime would run the call with input the user edited. */
  rewrites?: boolean
  /** Told the request's id once it waits for the user. */
  opened?: (id: string) => void
}

/** The call the user allowed after a restart cut it off runs once without a second request. */
async function allowedAlready(taskId: string, ask: Ask, hash: string): Promise<Answer | null> {
  const task = takeGrant(taskId, hash) ? await tasks.get(taskId) : undefined
  return task === undefined
    ? null
    : { result: allowed({ tool_name: ask.tool }, ask.input, await permissionModeOf(task)) }
}

/** Waits again on a request a node's ask recorded before this control plane restarted. */
async function waitAgain(request: PermissionRequest, ask: Ask, signals: readonly AbortSignal[]) {
  inputs.set(request.id, ask.input)
  const answer = answerOf(request.id, signals)
  ask.opened?.(request.id)
  try {
    await announce(request)
    return await answer
  } finally {
    inputs.delete(request.id)
    waiting.delete(request.id)
  }
}

/**
 * Records the call, shows it to the user, and waits for their answer. A node's ask names the
 * request, so the same ask sent again after a restart waits on the request it recorded.
 */
async function askUser(taskId: string, ask: Ask, signals: readonly AbortSignal[]): Promise<Answer> {
  const hash = callHash(ask.tool, ask.input)
  const granted = await allowedAlready(taskId, ask, hash)
  if (granted !== null) {
    return granted
  }
  const asked = askBeingAnswered()
  const known = asked === null ? undefined : await permissionRequests.get(asked)
  if (known?.state === 'pending') {
    return waitAgain(known, ask, signals)
  }
  const id = asked !== null && known === undefined ? asked : randomUUID()
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
      editable: ask.kind !== 'repeat' && (ask.rewrites ?? rewritesInput()) && isEditable(ask.tool, ask.input),
      input_hash: hash,
      timeout_minutes: (await timeoutSettings.get()).request_timeout_minutes,
    })
    if (waiting.has(id)) {
      ask.opened?.(id)
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
  (taskId: string, session: AbortSignal) =>
  async (...[tool, input, options]: Parameters<CanUseTool>): Promise<Answer> => {
    if (tool === ASK_TOOL) {
      return { result: await askQuestions(taskId, input, options, session) }
    }
    const server = signInServer(tool)
    if (server !== null) {
      await setStall(taskId, 'mcp', `Sign in to the ${server} MCP server in Seti`)
      return { result: { behavior: 'deny', message: signInMessage(server) } }
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
): Promise<PermissionResult> =>
  (await askUser(taskId, { ...call, kind: 'repeat', reason, suggestions: [] }, signals)).result

/** Asks the user about a command that pushes outside their organisations; Always adds `PushTo`. */
export const askAboutPush = async (
  taskId: string,
  call: { tool: string; input: Record<string, unknown>; reason: string; owners: readonly string[] },
  signals: readonly AbortSignal[],
): Promise<PermissionResult> => {
  const owners = [...new Set(call.owners)].map((owner) => `PushTo(${owner})`)
  return (await askUser(taskId, { ...call, kind: 'tool', suggestions: owners }, signals)).result
}

const REVIEW_REASON = 'A review rule holds this call for you to check, and edit, before it runs'

/** Asks the user about an MCP call a review rule holds; no rules, as review asks each time. */
export const askForReview = async (
  taskId: string,
  call: { tool: string; input: Record<string, unknown> },
  signals: readonly AbortSignal[],
): Promise<Answer> => askUser(taskId, { ...call, kind: 'review', reason: REVIEW_REASON, suggestions: [] }, signals)

/** What the user answered a request, or that the session dropped it before they did. */
export type UserAnswer = { allow: true } | { allow: false; message: string; dropped: boolean }

/**
 * Asks the user about a Codex agent's call: Allow and Deny only, since a rule Always allow would
 * add does not answer for a Codex agent, and no edits, since Codex runs a call as it asked.
 */
export async function askCodexUser(
  taskId: string,
  call: Pick<Ask, 'tool' | 'input' | 'reason' | 'opened'> & { review: boolean },
  signals: readonly AbortSignal[],
): Promise<UserAnswer> {
  const kind = call.review ? 'review' : 'tool'
  const ask: Ask = { ...call, kind, suggestions: [], rewrites: false }
  const { result } = await askUser(taskId, ask, signals)
  if (result.behavior === 'allow') {
    return { allow: true }
  }
  return { allow: false, message: result.message, dropped: result.interrupt === true }
}

/**
 * Settles a request Seti's rules now decide, unless the user answered it or its session stopped
 * waiting first; the stored state is the one answer the agent gets. `won` runs before the agent
 * gets it. Returns the request, or undefined.
 */
export async function answerByRules(
  id: string,
  answer: UserAnswer,
  won: () => void,
): Promise<PermissionRequest | undefined> {
  if (!waitsFor(id)) {
    return undefined
  }
  const message = answer.allow ? null : answer.message
  const settled = await permissionRequests.settle(id, answer.allow ? 'allowed' : 'denied', message)
  if (settled === undefined) {
    return undefined
  }
  won()
  const result: PermissionResult = answer.allow
    ? { behavior: 'allow', updatedInput: waitingInput(id) }
    : { behavior: 'deny', message: answer.message }
  await resolveRequest(settled, result)
  return settled
}
