import type { RuntimeEvent, ToolResult } from '../../events.js'
import { isRecord } from '../../lenient.js'
import { filled, list, num, obj, some, str } from './fields.js'

const BACKGROUND_ID = /running in background with ID: ([\w-]+)/
const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/
const LAUNCHED = /^(Async|Remote) agent launched/
const AGENT_ID = /agentId: (\w+)/
const EXIT_CODE = /^Exit code (-?\d+)/
const CREATED = /^Task #(\S+) created successfully/

const AGENT_TRAILER = 'agentId:'
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed'])

type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** A tool result's text parts, those that are not a subagent's id line, and its image count. */
function contentOf(content: unknown): { texts: string[]; kept: string[]; images: number } {
  if (typeof content === 'string') {
    return { texts: [content], kept: [content], images: 0 }
  }
  const parts = Array.isArray(content) ? content.filter(isRecord) : []
  const texts = parts.flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
  const kept = texts.filter((part) => !part.startsWith(AGENT_TRAILER))
  return { texts, kept, images: parts.filter((part) => part.type === 'image').length }
}

/** Where a call's work went on in the background: a shell's id and output, or an agent's id. */
function jobOf(text: string, structured: unknown): ToolResult['job'] {
  const shell = filled(structured, 'backgroundTaskId') ?? BACKGROUND_ID.exec(text)?.[1]
  if (shell !== undefined) {
    return { id: shell, ...some('output', OUTPUT_PATH.exec(text)?.[1]) }
  }
  const status = str(structured, 'status')
  if (status === 'async_launched' || status === 'remote_launched' || LAUNCHED.test(text)) {
    return { id: str(structured, 'agentId') ?? AGENT_ID.exec(text)?.[1] ?? null }
  }
  return undefined
}

/** The final report the structured Agent output carries, without the model-directed trailer. */
function reportOf(structured: unknown): string | undefined {
  const parts = list(structured, 'content').flatMap((part) => {
    const text = filled(part, 'text')
    return text === undefined ? [] : [text]
  })
  return parts.length === 0 ? undefined : parts.join('\n')
}

function agentUsage(structured: unknown) {
  const tokens = num(structured, 'totalTokens')
  return tokens === undefined
    ? undefined
    : {
        tokens,
        toolUses: num(structured, 'totalToolUseCount') ?? 0,
        durationMs: num(structured, 'totalDurationMs') ?? 0,
      }
}

/** A subagent's result: Claude Code ends it with an `agentId:` part and reports it structured. */
function agentOf(texts: string[], kept: string[], structured: unknown): ToolResult['agent'] {
  const done = str(structured, 'status') === 'completed'
  const usage = agentUsage(structured)
  const text = kept.join('\n')
  const id = filled(structured, 'agentId') ?? AGENT_ID.exec(text)?.[1]
  if (kept.length === texts.length && id === undefined && usage === undefined && !done) {
    return undefined
  }
  return {
    ...some('id', id),
    text,
    done,
    ...some('report', reportOf(structured)),
    ...some('usage', usage),
  }
}

const planStatus = (value: unknown): value is PlanStatus => typeof value === 'string' && PLAN_STATUSES.has(value)

function planItem(task: unknown): { id: string; status: PlanStatus; text?: string } | undefined {
  const id = filled(task, 'id')
  const status = isRecord(task) ? task.status : undefined
  return id === undefined || !planStatus(status) ? undefined : { id, status, ...some('text', filled(task, 'subject')) }
}

/** The plan Claude Code's task tools report in their structured output. */
function planOf(structured: unknown): ToolResult['plan'] {
  const tasks = isRecord(structured) ? structured.tasks : undefined
  const items = Array.isArray(tasks)
    ? tasks.flatMap((task: unknown) => {
        const item = planItem(task)
        return item?.text === undefined ? [] : [{ id: item.id, text: item.text, status: item.status }]
      })
    : undefined
  const report = {
    ...some('items', items),
    ...some('item', planItem(obj(structured, 'task'))),
    ...(isRecord(structured) && structured.success === false ? { unchanged: true } : {}),
  }
  return Object.keys(report).length === 0 ? undefined : report
}

function exitCodeOf(text: string): number | undefined {
  const code = EXIT_CODE.exec(text.trimStart())?.[1]
  return code === undefined ? undefined : Number(code)
}

/**
 * The tool results of one Claude Code user message; `structured` is its `tool_use_result`, which
 * every result carries, though the plan is read from it only when the message holds one result.
 */
export function toolResults(content: unknown, thread: string, structured: unknown): RuntimeEvent[] {
  const blocks = Array.isArray(content)
    ? content.filter((block) => isRecord(block) && block.type === 'tool_result')
    : []
  const own = blocks.length === 1 ? structured : undefined
  return blocks.map((block) => {
    const { texts, kept, images } = contentOf(isRecord(block) ? block.content : undefined)
    const text = texts.join('\n')
    const result: ToolResult = {
      text,
      images,
      ...some('exitCode', exitCodeOf(text)),
      ...some('job', jobOf(text, structured)),
      ...some('agent', agentOf(texts, kept, structured)),
      ...some('planId', filled(obj(own, 'task'), 'id') ?? CREATED.exec(text)?.[1]),
      ...some('plan', planOf(own)),
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
