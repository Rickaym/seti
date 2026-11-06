import type { TaskStatus } from '@seti/shared'
import { messages } from './db.js'

/** A content block of an assistant message, as far as the classifier reads it. */
export interface TurnBlock {
  type: string
  text?: string | undefined
  name?: string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringOf = (value: unknown) => (typeof value === 'string' ? value : undefined)

function blocksOf(payload: string): TurnBlock[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return []
  }
  const message = isRecord(parsed) ? parsed.message : undefined
  const content = isRecord(message) ? message.content : undefined
  if (!Array.isArray(content)) {
    return []
  }
  return content.filter(isRecord).flatMap((block) => {
    const type = stringOf(block.type)
    return type === undefined ? [] : [{ type, text: stringOf(block.text), name: stringOf(block.name) }]
  })
}

/** The content blocks of stored assistant messages, in order; unreadable ones are left out. */
export const turnBlocks = (payloads: readonly string[]): TurnBlock[] => payloads.flatMap(blocksOf)

/** Claude Code's tool for asking the user to pick between options. */
const ASK_TOOL = 'AskUserQuestion'

const FENCE = /^ {0,3}(`{3,}|~{3,})/

/** The text with fenced code blocks taken out; an unclosed fence runs to the end. */
function withoutCode(text: string): string {
  const kept: string[] = []
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const marker = FENCE.exec(line)?.[1]
    if (fence === null && marker !== undefined) {
      fence = marker
    } else if (fence !== null && marker?.startsWith(fence.charAt(0)) === true && marker.length >= fence.length) {
      fence = null
    } else if (fence === null) {
      kept.push(line)
    }
  }
  return kept.join('\n')
}

/** Markdown and punctuation that may close a sentence after its question mark. */
const CLOSERS = new Set([' ', '*', '_', '"', "'", ')', ']'])

function withoutClosers(paragraph: string): string {
  let end = paragraph.length
  while (end > 0 && CLOSERS.has(paragraph.charAt(end - 1))) {
    end -= 1
  }
  return paragraph.slice(0, end)
}

/** Whether the prose's last paragraph, outside code blocks, ends with a question mark. */
export function endsWithQuestion(text: string): boolean {
  const paragraphs = withoutCode(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '')
  const last = paragraphs.at(-1)
  return last !== undefined && withoutClosers(last).endsWith('?')
}

/**
 * Whether a turn ends by asking the user something: its last tool use was AskUserQuestion, or the
 * text it wrote after its last tool use ends with a question. Blocks come oldest first.
 */
export function endsAsking(blocks: readonly TurnBlock[]): boolean {
  const lastTool = blocks.findLastIndex((block) => block.type === 'tool_use')
  if (blocks[lastTool]?.name === ASK_TOOL) {
    return true
  }
  const closing = blocks
    .slice(lastTool + 1)
    .flatMap((block) => (block.type === 'text' && block.text !== undefined ? [block.text] : []))
  return endsWithQuestion(closing.join('\n\n'))
}

/** Whether a turn that ended in `status` asked the user something; only a clean end can. */
export async function turnAsks(taskId: string, status: TaskStatus): Promise<boolean> {
  return status === 'idle' && endsAsking(turnBlocks(await messages.turnEnding(taskId)))
}
