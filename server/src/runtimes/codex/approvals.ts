import type { ToolCall } from '@seti/shared'
import { z } from 'zod'

/** How Seti answers a call Codex asks about: run it, or refuse it with a reason the model reads. */
type CodexVerdict = { allow: true; input?: Record<string, unknown> } | { allow: false; message: string }

/** Seti's decision on one call, until the signal aborts because Codex no longer waits. */
export type CodexDecide = (call: ToolCall, signal: AbortSignal) => Promise<CodexVerdict>

const commandRequest = z.looseObject({
  itemId: z.string(),
  kind: z.string().optional(),
  command: z.string().nullish(),
  cwd: z.string().nullish(),
  commandActions: z.array(z.looseObject({ command: z.string() })).nullish(),
})

const fileRequest = z.looseObject({ itemId: z.string() })

const mcpRequest = z.looseObject({
  serverName: z.string(),
  _meta: z.looseObject({ codex_approval_kind: z.string(), tool_name: z.string(), tool_params: z.unknown() }),
})

const questionRequest = z.looseObject({
  itemId: z.string(),
  questions: z.array(z.looseObject({ id: z.string(), question: z.string(), header: z.string().nullish() })),
})

/** A request Seti answers, as a call to decide and the reply each verdict makes. */
export interface Asked {
  call: ToolCall
  reply: (verdict: CodexVerdict) => unknown
  /** The reply when Codex no longer needs an answer, as after an interrupt. */
  cancelled: unknown
}

type Started = (itemId: string) => ToolCall | undefined

const accept = (verdict: CodexVerdict) => ({ decision: verdict.allow ? 'accept' : 'decline' })

function command(params: unknown, started: Started): Asked {
  const request = commandRequest.parse(params)
  if (request.kind === 'writeStdin') {
    throw new Error('Seti does not let Codex write to a running command')
  }
  const fromRequest = request.commandActions?.[0]?.command ?? request.command ?? ''
  const call: ToolCall = started(request.itemId) ?? {
    callId: request.itemId,
    kind: 'shell',
    name: 'exec_command',
    input: { command: fromRequest },
    shell: { action: 'run', command: fromRequest },
  }
  return { call, reply: accept, cancelled: { decision: 'cancel' } }
}

function fileChange(params: unknown, started: Started): Asked {
  const { itemId } = fileRequest.parse(params)
  const call = started(itemId)
  if (call === undefined) {
    throw new Error(`Codex asked about an edit Seti never saw start (${itemId})`)
  }
  return { call, reply: accept, cancelled: { decision: 'cancel' } }
}

function mcp(params: unknown): Asked {
  const request = mcpRequest.parse(params)
  if (request._meta.codex_approval_kind !== 'mcp_tool_call') {
    throw new Error(`Seti does not answer ${request._meta.codex_approval_kind} elicitations`)
  }
  const server = request.serverName
  const tool = request._meta.tool_name
  const call: ToolCall = {
    callId: `${server}:${tool}`,
    kind: 'mcp',
    name: `mcp__${server}__${tool}`,
    input: request._meta.tool_params,
    mcp: { server, tool },
  }
  const reply = (verdict: CodexVerdict) => ({
    action: verdict.allow ? 'accept' : 'decline',
    content: null,
    _meta: null,
  })
  return { call, reply, cancelled: { action: 'cancel', content: null, _meta: null } }
}

/** The user's answers by question text, as a question verdict carries them. */
function answersOf(verdict: CodexVerdict): Map<string, string> {
  const given = verdict.allow ? verdict.input?.answers : undefined
  const entries = typeof given === 'object' && given !== null ? Object.entries(given) : []
  return new Map(entries.flatMap(([text, answer]) => (typeof answer === 'string' ? [[text, answer] as const] : [])))
}

function question(params: unknown, started: Started): Asked {
  const request = questionRequest.parse(params)
  const call = started(request.itemId)
  if (call === undefined) {
    throw new Error('A question reached Seti before its call')
  }
  const reply = (verdict: CodexVerdict) => {
    const given = answersOf(verdict)
    const answers = request.questions.map((one) => [one.id, { answers: [given.get(one.question) ?? ''] }] as const)
    return { answers: Object.fromEntries(answers) }
  }
  return { call, reply, cancelled: { answers: {} } }
}

type Reader = (params: unknown, started: Started) => Asked

const READERS: Partial<Record<string, Reader>> = {
  'item/commandExecution/requestApproval': command,
  'item/fileChange/requestApproval': fileChange,
  'mcpServer/elicitation/request': mcp,
  'item/tool/requestUserInput': question,
}

/**
 * The call a request of Codex's asks about and how to reply; null for a request Seti does not
 * answer. Answers are only accept or decline, never "for the session": every call comes back.
 */
export function askedOf(method: string, params: unknown, started: Started): Asked | null {
  return READERS[method]?.(params, started) ?? null
}
