import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { MessageRow, Subtask, SubtaskBrief, SubtaskProgress, SubtaskStatus, SubtaskUsage } from '@seti/shared'
import { trimText } from './transcript.js'

type AssistantBlock = SDKAssistantMessage['message']['content'][number]
type ToolUseBlock = Extract<AssistantBlock, { type: 'tool_use' }>
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>
type SystemMessage = Extract<SDKMessage, { type: 'system' }>
type TaskMessage = Extract<
  SystemMessage,
  { subtype: 'task_started' | 'task_progress' | 'task_updated' | 'task_notification' }
>
type Of<S extends TaskMessage['subtype']> = Extract<TaskMessage, { subtype: S }>

/** Tool names that start a subagent; older Claude Code versions call it Task. */
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const SUMMARY_CHARS = 200
const LAUNCHED = /^(Async|Remote) agent launched/

type Ended = Exclude<SubtaskStatus, 'running' | 'unknown'>

interface Draft {
  tool_use_id: string
  tool_use_ids: string[]
  parent_tool_use_id: string | null
  message_id: number
  sdk_task_id: string | null
  description: string
  subagent_type: string | null
  prompt: string
  background: boolean
  ended: Ended | null
  /** The SDK reported on it while Seti ran it, so a query that closed without an outcome ended it. */
  live: boolean
  /** Id of the message that last started or resumed it. */
  since: number
  progress: SubtaskProgress | null
  usage: SubtaskUsage | null
  started_at: string
  ended_at: string | null
  result: string | null
}

type Patch = Partial<Draft>

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | null {
  const found = field(value, key)
  return typeof found === 'string' && found.trim() !== '' ? found : null
}

function count(value: unknown, key: string): number | null {
  const found = field(value, key)
  return typeof found === 'number' && Number.isFinite(found) ? found : null
}

function resultText(block: ToolResultBlock): string {
  const { content } = block
  if (content === undefined) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content
    .flatMap((part) => (part.type === 'text' && !part.text.startsWith('agentId:') ? [part.text] : []))
    .join('\n')
}

/** The final report the structured Agent output carries, without the model-directed trailer. */
function reportText(output: unknown): string | null {
  const content = field(output, 'content')
  if (!Array.isArray(content)) {
    return null
  }
  const parts = content.flatMap((part: unknown) => {
    const value = text(part, 'text')
    return value === null ? [] : [value]
  })
  return parts.length === 0 ? null : parts.join('\n')
}

function outputUsage(output: unknown): SubtaskUsage | null {
  const tokens = count(output, 'totalTokens')
  if (tokens === null) {
    return null
  }
  return {
    total_tokens: tokens,
    tool_uses: count(output, 'totalToolUseCount') ?? 0,
    duration_ms: count(output, 'totalDurationMs') ?? 0,
  }
}

const resumed = (row: MessageRow): Patch => ({ ended: null, ended_at: null, since: row.id })

function newDraft(row: MessageRow, block: ToolUseBlock, parent: string | null): Draft {
  return {
    tool_use_id: block.id,
    tool_use_ids: [],
    parent_tool_use_id: parent,
    message_id: row.id,
    sdk_task_id: null,
    description: text(block.input, 'description') ?? 'Subagent',
    subagent_type: text(block.input, 'subagent_type'),
    prompt: text(block.input, 'prompt') ?? '',
    background: field(block.input, 'run_in_background') === true,
    ended: null,
    live: false,
    since: row.id,
    progress: null,
    usage: null,
    started_at: row.created_at,
    ended_at: null,
    result: null,
  }
}

/** What the Agent call's own tool result says: launched in the background, failed, or finished. */
function agentResultPatch(draft: Draft, row: MessageRow, block: ToolResultBlock, output: unknown): Patch {
  const body = resultText(block)
  const status = field(output, 'status')
  if (status === 'async_launched' || status === 'remote_launched' || LAUNCHED.test(body)) {
    return { background: true }
  }
  if (block.is_error === true) {
    return { result: body, ended: 'failed', ended_at: row.created_at }
  }
  if (status !== 'completed' && draft.background) {
    return {}
  }
  const usage = outputUsage(output) ?? draft.usage
  return { result: reportText(output) ?? body, usage, ended: 'completed', ended_at: row.created_at }
}

const agentIdOf = (block: ToolResultBlock, output: unknown) =>
  text(output, 'agentId') ?? /agentId: (\w+)/.exec(resultText(block))?.[1] ?? null

const startedPatch = (draft: Draft, row: MessageRow, m: Of<'task_started'>): Patch => ({
  ...resumed(row),
  background: m.is_backgrounded ?? draft.background,
  subagent_type: draft.subagent_type ?? m.subagent_type ?? null,
})

const progressPatch = (m: Of<'task_progress'>): Patch => ({
  progress: { description: m.description, last_tool: m.last_tool_name ?? null, summary: m.summary ?? null },
  usage: m.usage,
})

const ENDED_BY_PATCH: Partial<Record<string, Ended>> = { completed: 'completed', failed: 'failed', killed: 'stopped' }

function updatedPatch(draft: Draft, row: MessageRow, m: Of<'task_updated'>): Patch {
  const background = m.patch.is_backgrounded ?? draft.background
  const ended = ENDED_BY_PATCH[m.patch.status ?? '']
  if (ended === undefined || draft.ended !== null) {
    return { background }
  }
  const at = m.patch.end_time === undefined ? row.created_at : new Date(m.patch.end_time).toISOString()
  return { background, ended, ended_at: at, result: draft.result ?? m.patch.error ?? null }
}

const notificationPatch = (draft: Draft, row: MessageRow, m: Of<'task_notification'>): Patch => ({
  ended: m.status,
  ended_at: row.created_at,
  result: m.summary.trim() === '' ? draft.result : m.summary,
  usage: m.usage ?? draft.usage,
})

function taskPatch(draft: Draft, row: MessageRow, m: TaskMessage): Patch {
  switch (m.subtype) {
    case 'task_started':
      return startedPatch(draft, row, m)
    case 'task_progress':
      return progressPatch(m)
    case 'task_updated':
      return updatedPatch(draft, row, m)
    case 'task_notification':
      return notificationPatch(draft, row, m)
  }
}

const isTaskMessage = (m: SystemMessage): m is TaskMessage =>
  m.subtype === 'task_started' ||
  m.subtype === 'task_progress' ||
  m.subtype === 'task_updated' ||
  m.subtype === 'task_notification'

const toolUseOf = (m: TaskMessage) => (m.subtype === 'task_updated' ? undefined : m.tool_use_id)

function firstLine(value: string | null): string | null {
  const line = value
    ?.split('\n')
    .map((part) => part.replace(/[#*`>]/g, '').trim())
    .find((part) => part !== '')
  if (line === undefined) {
    return null
  }
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 3).trimEnd()}...` : line
}

/** A subagent without an outcome runs if the open query started it; otherwise it ended unseen. */
function statusOf(draft: Draft, openSince: number | null): SubtaskStatus {
  if (draft.ended !== null) {
    return draft.ended
  }
  if (openSince !== null && draft.since >= openSince) {
    return 'running'
  }
  return draft.live ? 'stopped' : 'unknown'
}

function briefOf(draft: Draft, openSince: number | null): SubtaskBrief {
  return {
    tool_use_id: draft.tool_use_id,
    tool_use_ids: [...draft.tool_use_ids],
    parent_tool_use_id: draft.parent_tool_use_id,
    message_id: draft.message_id,
    sdk_task_id: draft.sdk_task_id,
    description: draft.description,
    subagent_type: draft.subagent_type,
    background: draft.background,
    status: statusOf(draft, openSince),
    progress: draft.progress,
    usage: draft.usage,
    started_at: draft.started_at,
    ended_at: draft.ended_at,
    summary: firstLine(draft.result),
    pr_urls: [],
  }
}

/**
 * The subtasks of one task, folded from its messages in id order. Each Agent tool call is one;
 * task events and tool results about other tools, such as background Bash commands, are ignored.
 */
export class SubtaskIndex {
  lastId = 0
  private readonly drafts: Draft[] = []
  /** Agent calls and the SendMessage calls that resumed them, by tool use id. */
  private readonly byCall = new Map<string, Draft>()
  /** Subagents by the SDK task id, agent id or name that SendMessage addresses them with. */
  private readonly byAgent = new Map<string, Draft>()

  /** Folds one message in; true when it changed a subtask. Older messages are ignored. */
  apply(row: MessageRow): boolean {
    if (row.id <= this.lastId) {
      return false
    }
    this.lastId = row.id
    if (row.kind !== 'sdk') {
      return false
    }
    const m = row.payload
    if (m.type === 'assistant') {
      return this.applyAssistant(row, m)
    }
    if (m.type === 'user') {
      return this.applyUser(row, m)
    }
    return m.type === 'system' && isTaskMessage(m) ? this.applyTask(row, m) : false
  }

  /**
   * The subtasks in the order they started. `openSince` is the first message of the task's open
   * query, or null when none is open: only that query can still be running a subagent.
   */
  briefs(openSince: number | null): SubtaskBrief[] {
    return this.drafts.map((draft) => briefOf(draft, openSince))
  }

  /** One subtask with its prompt and final report, found by any of its tool use ids. */
  find(toolUseId: string, openSince: number | null): Subtask | null {
    const draft = this.byCall.get(toolUseId)
    if (!draft) {
      return null
    }
    const result = draft.result === null ? null : trimText(draft.result)
    return { ...briefOf(draft, openSince), prompt: trimText(draft.prompt), result }
  }

  private alias(draft: Draft, toolUseId: string): void {
    if (!this.byCall.has(toolUseId)) {
      this.byCall.set(toolUseId, draft)
      draft.tool_use_ids.push(toolUseId)
    }
  }

  private start(row: MessageRow, block: ToolUseBlock, parent: string | null): boolean {
    if (this.byCall.has(block.id)) {
      return false
    }
    const draft = newDraft(row, block, parent === null ? null : (this.byCall.get(parent)?.tool_use_id ?? parent))
    this.alias(draft, block.id)
    const name = text(block.input, 'name')
    if (name !== null) {
      this.byAgent.set(name, draft)
    }
    this.drafts.push(draft)
    return true
  }

  private applyAssistant(row: MessageRow, m: SDKAssistantMessage): boolean {
    let changed = false
    for (const block of m.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      if (AGENT_TOOLS.has(block.name)) {
        changed = this.start(row, block, m.parent_tool_use_id) || changed
        continue
      }
      const target = block.name === 'SendMessage' ? this.byAgent.get(text(block.input, 'to') ?? '') : undefined
      if (target) {
        this.alias(target, block.id)
        changed = true
      }
    }
    return changed
  }

  private applyUser(row: MessageRow, m: SDKUserMessage): boolean {
    if (typeof m.message.content === 'string') {
      return false
    }
    let changed = false
    for (const block of m.message.content) {
      const draft = block.type === 'tool_result' ? this.byCall.get(block.tool_use_id) : undefined
      if (block.type !== 'tool_result' || draft === undefined) {
        continue
      }
      changed = true
      if (draft.tool_use_id === block.tool_use_id) {
        const agentId = agentIdOf(block, m.tool_use_result)
        if (agentId !== null) {
          this.byAgent.set(agentId, draft)
        }
        Object.assign(draft, agentResultPatch(draft, row, block, m.tool_use_result))
      } else if (block.is_error !== true) {
        Object.assign(draft, resumed(row))
      }
    }
    return changed
  }

  private applyTask(row: MessageRow, m: TaskMessage): boolean {
    const toolUseId = toolUseOf(m)
    const draft = (toolUseId === undefined ? undefined : this.byCall.get(toolUseId)) ?? this.byAgent.get(m.task_id)
    if (!draft) {
      return false
    }
    this.byAgent.set(m.task_id, draft)
    if (m.subtype === 'task_started' && toolUseId !== undefined) {
      this.alias(draft, toolUseId)
    }
    Object.assign(draft, { live: true, sdk_task_id: m.task_id }, taskPatch(draft, row, m))
    return true
  }
}

export function deriveSubtasks(rows: readonly MessageRow[], openSince: number | null): SubtaskBrief[] {
  const index = new SubtaskIndex()
  for (const row of rows) {
    index.apply(row)
  }
  return index.briefs(openSince)
}
