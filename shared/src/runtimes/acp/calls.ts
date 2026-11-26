import { z } from 'zod'
import type { ToolCall, ToolKind, ToolResult } from '../../events.js'
import { sessionUpdate, type AcpToolCall } from './shapes.js'

type Content = NonNullable<AcpToolCall['content']>[number]

const shown = z.looseObject({
  type: z.literal('content'),
  content: z.looseObject({ type: z.string(), text: z.string().optional() }),
})
const diff = z.looseObject({
  type: z.literal('diff'),
  path: z.string(),
  oldText: z.string().nullish(),
  newText: z.string(),
})
const mcpMeta = z.looseObject({
  'gemini-cli': z.looseObject({ mcp: z.looseObject({ server_name: z.string(), tool_name: z.string() }) }),
})

/** The tool's own name: what the call id holds before `__`, as Gemini CLI writes it. */
const toolName = (call: AcpToolCall): string => call.toolCallId.split('__')[0] ?? call.toolCallId

const KINDS: Record<string, ToolKind> = {
  execute: 'shell',
  read: 'read',
  edit: 'edit',
  delete: 'edit',
  move: 'edit',
  search: 'search',
  fetch: 'web',
  think: 'think',
}

/** The MCP server and tool a call names in its `_meta`, as Gemini CLI writes them. */
function mcpOf(call: AcpToolCall): { server: string; tool: string } | null {
  const meta = mcpMeta.safeParse(call._meta)
  return meta.success
    ? { server: meta.data['gemini-cli'].mcp.server_name, tool: meta.data['gemini-cli'].mcp.tool_name }
    : null
}

/** The parts of a call's content that show something, with the type of each. */
const shownParts = (content: readonly Content[] | undefined) =>
  (content ?? []).flatMap((part) => {
    const parsed = shown.safeParse(part)
    return parsed.success ? [parsed.data.content] : []
  })

const texts = (content: readonly Content[] | undefined): string[] =>
  shownParts(content).flatMap((part) => (part.text === undefined ? [] : [part.text]))

/** A shell call's description, which Gemini CLI puts after the working folder in brackets. */
const SHELL_NOTE = /^\[current working directory [^\]]*\](?: \((?<description>[\s\S]*)\))?$/

function shellOf(call: AcpToolCall): NonNullable<ToolCall['shell']> {
  const description = texts(call.content)
    .map((each) => SHELL_NOTE.exec(each)?.groups?.description)
    .find((each) => each !== undefined)
  return {
    action: 'run',
    ...(call.title === undefined ? {} : { command: call.title }),
    ...(description === undefined ? {} : { description }),
  }
}

type Change = NonNullable<ToolCall['edit']>['changes'][number]

function changeOf(part: Content, kind: string | undefined): Change[] {
  const parsed = diff.safeParse(part)
  if (!parsed.success) {
    return []
  }
  const before = parsed.data.oldText ?? ''
  const created = before === '' ? 'create' : 'update'
  return [{ path: parsed.data.path, op: kind === 'delete' ? 'delete' : created, before, after: parsed.data.newText }]
}

/** The part of a call its kind reads, from what the agent showed of it. */
const DETAILS: Partial<Record<ToolKind, (call: AcpToolCall) => Partial<ToolCall>>> = {
  shell: (call) => ({ shell: shellOf(call) }),
  read: (call) => ({ read: { paths: (call.locations ?? []).map((each) => each.path) } }),
  edit: (call) => ({ edit: { changes: (call.content ?? []).flatMap((part) => changeOf(part, call.kind)) } }),
  search: (call) => ({ search: call.title === undefined ? {} : { pattern: call.title } }),
  web: (call) => ({ web: call.title === undefined ? {} : { url: call.title } }),
}

/** A tool call as Seti shows it; ACP sends no input, so the input is what the agent showed. */
export function callOf(call: AcpToolCall): ToolCall {
  const mcp = mcpOf(call)
  const kind: ToolKind = mcp === null ? (KINDS[call.kind ?? ''] ?? 'other') : 'mcp'
  return {
    callId: call.toolCallId,
    kind,
    name: toolName(call),
    input: { title: call.title, kind: call.kind, content: call.content, locations: call.locations },
    ...DETAILS[kind]?.(call),
    ...(mcp === null ? {} : { mcp }),
  }
}

/** The call an agent's permission request names, or null where Seti cannot read it. */
export function askedCall(toolCall: unknown): ToolCall | null {
  const fields = typeof toolCall === 'object' && toolCall !== null ? toolCall : {}
  const parsed = sessionUpdate.safeParse({ ...fields, sessionUpdate: 'tool_call' })
  return parsed.success && parsed.data.sessionUpdate === 'tool_call' ? callOf(parsed.data) : null
}

/** What an ended call returned: its text parts, and the images it carried by count. */
export function resultOf(call: AcpToolCall): ToolResult {
  const text = texts(call.content).join('\n')
  const images = shownParts(call.content).filter((part) => part.type === 'image').length
  return { text, images, ...(call.rawOutput === undefined ? {} : { structured: call.rawOutput }) }
}
