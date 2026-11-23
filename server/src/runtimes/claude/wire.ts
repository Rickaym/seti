import type { SDKAssistantMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeMessage } from '@seti/shared'
import { formatSize, marker, trimStrings, trimText, WIRE_TEXT_LIMIT, type Wire } from '../../wire-text.js'

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>
type ResultPart = Exclude<NonNullable<ToolResultBlock['content']>, string>[number]

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

/** A Claude Code message as the browser gets it: long texts cut, repeated tool output dropped. */
export function wireClaude(payload: ClaudeMessage): Wire<ClaudeMessage> {
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
