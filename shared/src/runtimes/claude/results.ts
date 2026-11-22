import type { RuntimeEvent, ToolResult } from '../../events.js'
import { isRecord } from '../../lenient.js'
import { list, obj, some, str } from './fields.js'

const BACKGROUND_ID = /running in background with ID: ([\w-]+)/
const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/
const LAUNCHED = /^(Async|Remote) agent launched/
const AGENT_ID = /agentId: (\w+)/
const EXIT_CODE = /^Exit code (-?\d+)/
const CREATED = /^Task #(\S+) created successfully/

/** The text parts of a tool result joined by lines, and how many images it holds. */
function contentOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') {
    return { text: content, images: 0 }
  }
  const parts = Array.isArray(content) ? content.filter(isRecord) : []
  const texts = parts.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
  return { text: texts.join('\n'), images: parts.filter((part) => part.type === 'image').length }
}

/** Where a call's work went on in the background: a shell's id and output, or an agent's id. */
function jobOf(text: string, structured: unknown): ToolResult['job'] {
  const shell = str(structured, 'backgroundTaskId') ?? BACKGROUND_ID.exec(text)?.[1]
  if (shell !== undefined) {
    return { id: shell, ...some('output', OUTPUT_PATH.exec(text)?.[1]) }
  }
  const status = str(structured, 'status')
  if (status === 'async_launched' || status === 'remote_launched' || LAUNCHED.test(text)) {
    return { id: str(structured, 'agentId') ?? AGENT_ID.exec(text)?.[1] ?? null }
  }
  return undefined
}

function exitCodeOf(text: string): number | undefined {
  const code = EXIT_CODE.exec(text.trimStart())?.[1]
  return code === undefined ? undefined : Number(code)
}

/** The tool results of one Claude Code user message; `structured` is its `tool_use_result`. */
export function toolResults(content: unknown, thread: string, structured: unknown): RuntimeEvent[] {
  const blocks = Array.isArray(content)
    ? content.filter((block) => isRecord(block) && block.type === 'tool_result')
    : []
  return blocks.map((block) => {
    const { text, images } = contentOf(isRecord(block) ? block.content : undefined)
    const result: ToolResult = {
      text,
      images,
      ...some('exitCode', exitCodeOf(text)),
      ...some('job', jobOf(text, structured)),
      ...some('planId', str(obj(structured, 'task'), 'id') ?? CREATED.exec(text)?.[1]),
      ...some('structured', structured),
    }
    const failed = isRecord(block) && block.is_error === true
    return {
      v: 1,
      thread,
      type: 'tool.ended',
      callId: str(block, 'tool_use_id') ?? '',
      status: failed ? 'error' : 'ok',
      result,
    }
  })
}

/** A user message's text: its string content or its text blocks run together; null if none. */
export function userText(content: unknown): string | null {
  if (typeof content === 'string') {
    return content
  }
  const texts = list({ content }, 'content').flatMap((block) =>
    isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  )
  return texts.length === 0 ? null : texts.join('')
}
