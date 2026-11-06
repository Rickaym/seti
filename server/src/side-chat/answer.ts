import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { SideChatEvent } from '@seti/shared'
import { redactSecrets } from '../scrub.js'

/** Least time between two snapshots of a streaming answer. */
const TEXT_EVERY_MS = 100
const TOOL_CHARS = 160

/** The answer as it streams: redacted, and without its unfinished last word, which may be a key. */
export function streamingText(text: string): string {
  let end = text.length
  while (end > 0 && !/\s/.test(text.charAt(end - 1))) {
    end--
  }
  return redactSecrets(text.slice(0, end))
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const stringField = (input: unknown, key: string): string | null =>
  isRecord(input) && typeof input[key] === 'string' ? input[key] : null

/** "Read src/app.ts" for a read the answer makes, redacted and cut short. */
function toolLine(name: string, input: unknown): string {
  const target = stringField(input, 'file_path') ?? stringField(input, 'pattern') ?? stringField(input, 'path') ?? ''
  const line = redactSecrets(`${name} ${target}`.trim())
  return line.length > TOOL_CHARS ? `${line.slice(0, TOOL_CHARS - 3)}...` : line
}

/** The text a streamed delta adds, when the message is one of the main thread's text deltas. */
function deltaText(m: SDKMessage): string | null {
  if (m.type !== 'stream_event' || m.parent_tool_use_id !== null || m.event.type !== 'content_block_delta') {
    return null
  }
  return m.event.delta.type === 'text_delta' ? m.event.delta.text : null
}

/** Follows a side chat fork's messages and says what to stream: the answer so far and its reads. */
export class AnswerStream {
  private readonly blocks: string[] = []
  private partial = ''
  private sentAt = Number.NEGATIVE_INFINITY

  /** The whole answer so far, unredacted. */
  get text(): string {
    return [...this.blocks, this.partial].filter((block) => block.trim() !== '').join('\n\n')
  }

  /** The event a message of the fork calls for, or null when it shows nothing new. */
  next(m: SDKMessage, at = Date.now()): SideChatEvent | null {
    const delta = deltaText(m)
    if (delta !== null) {
      this.partial += delta
      return this.snapshot(at, false)
    }
    if (m.type !== 'assistant' || m.parent_tool_use_id !== null) {
      return null
    }
    const content: unknown[] = Array.isArray(m.message.content) ? m.message.content : []
    let tool: string | null = null
    for (const block of content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        this.blocks.push(block.text)
        this.partial = ''
      } else if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
        tool = toolLine(block.name, block.input)
      }
    }
    return tool === null ? this.snapshot(at, true) : { type: 'tool', text: tool }
  }

  private snapshot(at: number, force: boolean): SideChatEvent | null {
    if (!force && at - this.sentAt < TEXT_EVERY_MS) {
      return null
    }
    this.sentAt = at
    return { type: 'text', text: this.partial === '' ? redactSecrets(this.text) : streamingText(this.text) }
  }
}
