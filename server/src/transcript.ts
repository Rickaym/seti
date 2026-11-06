import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { sandboxViolations, type MessagePage, type MessageRow, type ShellResult } from '@seti/shared'
import { scrubValue } from './scrub.js'

/** Characters of one tool text the browser gets before it asks for the full message. */
export const WIRE_TEXT_LIMIT = 16 * 1024

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>
type ResultPart = Exclude<NonNullable<ToolResultBlock['content']>, string>[number]

interface Wire<T> {
  value: T
  cut: string[]
}

function formatSize(chars: number): string {
  return chars >= 1024 * 1024 ? `${(chars / 1024 / 1024).toFixed(1)} MB` : `${String(Math.ceil(chars / 1024))} KB`
}

const marker = (original: number) =>
  `[trimmed for display: first ${formatSize(WIRE_TEXT_LIMIT)} of ${formatSize(original)} shown]`

/** What the sandbox refused, kept when the cut drops it, so trimmed output still shows it. */
function keptViolations(text: string, head: string): string {
  const violations = sandboxViolations(text)
  if (violations.length === 0 || sandboxViolations(head).length > 0) {
    return ''
  }
  return `\n<sandbox_violations>\n${violations.join('\n')}\n</sandbox_violations>`
}

/** Cuts text longer than the wire limit and marks how much the browser gets. */
export function trimText(text: string): string {
  if (text.length <= WIRE_TEXT_LIMIT) {
    return text
  }
  const head = text.slice(0, WIRE_TEXT_LIMIT)
  return `${head}\n\n${marker(text.length)}${keptViolations(text, head)}`
}

/** Trims every long string inside a JSON value, returning the same reference when nothing is cut. */
function trimStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return trimText(value)
  }
  if (Array.isArray(value)) {
    const next = value.map(trimStrings)
    return next.some((item, index) => item !== value[index]) ? next : value
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    const next = entries.map(([key, item]) => [key, trimStrings(item)] as const)
    return next.some(([, item], index) => item !== entries[index]?.[1]) ? Object.fromEntries(next) : value
  }
  return value
}

const partSize = (part: ResultPart) => (part.type === 'text' ? part.text.length : JSON.stringify(part).length)

/** Keeps the head of the text parts; other parts stay only while they fit in what is left. */
function trimResultParts(content: ResultPart[]): ResultPart[] {
  const original = content.reduce((sum, part) => sum + partSize(part), 0)
  if (original <= WIRE_TEXT_LIMIT) {
    return content
  }
  let budget = WIRE_TEXT_LIMIT
  const kept: ResultPart[] = []
  for (const part of content) {
    const size = partSize(part)
    if (part.type === 'text') {
      if (budget > 0) {
        kept.push({ ...part, text: part.text.slice(0, budget) })
      }
      budget -= size
    } else if (size <= budget) {
      kept.push(part)
      budget -= size
    } else {
      kept.push({ type: 'text', text: `[${part.type} block of ${formatSize(size)} omitted]` })
    }
  }
  return [...kept, { type: 'text', text: marker(original) }]
}

function wireToolResult(block: UserBlock): Wire<UserBlock> {
  if (block.type !== 'tool_result' || block.content === undefined) {
    return { value: block, cut: [] }
  }
  const content = typeof block.content === 'string' ? trimText(block.content) : trimResultParts(block.content)
  return content === block.content
    ? { value: block, cut: [] }
    : { value: { ...block, content }, cut: [block.tool_use_id] }
}

function wireAssistantBlock(block: AssistantBlock): Wire<AssistantBlock> {
  if (block.type === 'tool_use') {
    const input = trimStrings(block.input)
    return input === block.input ? { value: block, cut: [] } : { value: { ...block, input }, cut: [block.id] }
  }
  if (block.type === 'thinking') {
    return { value: { ...block, thinking: trimText(block.thinking), signature: '' }, cut: [] }
  }
  return { value: block, cut: [] }
}

function mapBlocks<T>(blocks: readonly T[], wire: (block: T) => Wire<T>): Wire<T[]> {
  const mapped = blocks.map(wire)
  return { value: mapped.map((m) => m.value), cut: mapped.flatMap((m) => m.cut) }
}

/** The user message without its structured tool output, which repeats the tool result text. */
function wireUser(message: SDKUserMessage): Wire<SDKUserMessage> {
  const rest = { ...message }
  delete rest.tool_use_result
  const { content } = message.message
  if (typeof content === 'string') {
    return { value: rest, cut: [] }
  }
  const blocks = mapBlocks(content, wireToolResult)
  return { value: { ...rest, message: { ...message.message, content: blocks.value } }, cut: blocks.cut }
}

function wirePayload(payload: SDKMessage): Wire<SDKMessage> {
  if (payload.type === 'assistant') {
    const blocks = mapBlocks(payload.message.content, wireAssistantBlock)
    return { value: { ...payload, message: { ...payload.message, content: blocks.value } }, cut: blocks.cut }
  }
  if (payload.type === 'user') {
    return wireUser(payload)
  }
  if (payload.type === 'system' && payload.subtype === 'init') {
    return { value: { ...payload, slash_commands: [], skills: [] }, cut: [] }
  }
  if (payload.type === 'result' && payload.subtype === 'success') {
    return { value: { ...payload, result: trimText(payload.result) }, cut: [] }
  }
  return { value: payload, cut: [] }
}

const SHELL_STREAMS = ['stdout', 'stderr'] as const

/** Shell output cut like tool text; `trimmed` names the streams that lost their tail. */
function wireShell(payload: ShellResult): Wire<ShellResult> {
  const cut = SHELL_STREAMS.filter((stream) => payload[stream].length > WIRE_TEXT_LIMIT)
  if (cut.length === 0) {
    return { value: payload, cut: [] }
  }
  return { value: { ...payload, stdout: trimText(payload.stdout), stderr: trimText(payload.stderr) }, cut }
}

function trimRow(row: MessageRow): MessageRow {
  if (row.kind === 'shell') {
    const { value, cut } = wireShell(row.payload)
    return cut.length === 0 ? row : { ...row, payload: value, trimmed: cut }
  }
  if (row.kind !== 'sdk') {
    return row
  }
  const { value, cut } = wirePayload(row.payload)
  return cut.length === 0 ? { ...row, payload: value } : { ...row, payload: value, trimmed: cut }
}

/** The browser copy of a stored message: text cut with a marker, credentials redacted. */
export const wireRow = (row: MessageRow): MessageRow => scrubValue(trimRow(row))

export const wirePage = (page: MessagePage): MessagePage => ({ ...page, messages: page.messages.map(wireRow) })
