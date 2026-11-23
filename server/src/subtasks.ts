import {
  type JobUsage,
  type MessageRow,
  type RuntimeEvent,
  type Subtask,
  type SubtaskBrief,
  type SubtaskProgress,
  type SubtaskStatus,
  type SubtaskUsage,
  type ToolCall,
  rowEvents,
  type EventOf,
} from '@seti/shared'
import { trimText } from './transcript.js'

type JobEvent = EventOf<'job.started'> | EventOf<'job.progress'> | EventOf<'job.updated'> | EventOf<'job.ended'>

const SUMMARY_CHARS = 200

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
  /** The runtime reported on it while Seti ran it, so a query closed without an outcome ended it. */
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

const usageOf = (usage: JobUsage): SubtaskUsage => ({
  total_tokens: usage.tokens,
  tool_uses: usage.toolUses,
  duration_ms: usage.durationMs,
})

const resumed = (row: MessageRow): Patch => ({ ended: null, ended_at: null, since: row.id })

function newDraft(
  row: MessageRow,
  call: ToolCall,
  subagent: NonNullable<ToolCall['subagent']>,
  parent: string | null,
): Draft {
  return {
    tool_use_id: call.callId,
    tool_use_ids: [],
    parent_tool_use_id: parent,
    message_id: row.id,
    sdk_task_id: null,
    description: subagent.label,
    subagent_type: subagent.agentType ?? null,
    prompt: subagent.prompt ?? '',
    background: subagent.background === true,
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

/** What the subagent call's own result says: launched in the background, failed, or finished. */
function agentResultPatch(draft: Draft, row: MessageRow, event: EventOf<'tool.ended'>): Patch {
  const { result } = event
  const body = result.agent?.text ?? result.text
  if (result.job !== undefined) {
    return { background: true }
  }
  if (event.status === 'error') {
    return { result: body, ended: 'failed', ended_at: row.created_at }
  }
  if (result.agent?.done !== true && draft.background) {
    return {}
  }
  const usage = result.agent?.usage === undefined ? draft.usage : usageOf(result.agent.usage)
  return { result: result.agent?.report ?? body, usage, ended: 'completed', ended_at: row.created_at }
}

const startedPatch = (draft: Draft, row: MessageRow, event: EventOf<'job.started'>): Patch => ({
  ...resumed(row),
  background: event.background ?? draft.background,
  subagent_type: draft.subagent_type ?? event.agentType ?? null,
})

const progressPatch = (event: EventOf<'job.progress'>): Patch => ({
  progress: { description: event.label, last_tool: event.lastTool ?? null, summary: event.summary ?? null },
  usage: usageOf(event.usage),
})

const ENDED_BY_PATCH: Partial<Record<string, Ended>> = { completed: 'completed', failed: 'failed', killed: 'stopped' }

function updatedPatch(draft: Draft, row: MessageRow, event: EventOf<'job.updated'>): Patch {
  const background = event.background ?? draft.background
  const ended = ENDED_BY_PATCH[event.status ?? '']
  if (ended === undefined || draft.ended !== null) {
    return { background }
  }
  return { background, ended, ended_at: event.endedAt ?? row.created_at, result: draft.result ?? event.error ?? null }
}

const endedPatch = (draft: Draft, row: MessageRow, event: EventOf<'job.ended'>): Patch => ({
  ended: event.status,
  ended_at: row.created_at,
  result: event.summary.trim() === '' ? draft.result : event.summary,
  usage: event.usage === undefined ? draft.usage : usageOf(event.usage),
})

function jobPatch(draft: Draft, row: MessageRow, event: JobEvent): Patch {
  switch (event.type) {
    case 'job.started':
      return startedPatch(draft, row, event)
    case 'job.progress':
      return progressPatch(event)
    case 'job.updated':
      return updatedPatch(draft, row, event)
    case 'job.ended':
      return endedPatch(draft, row, event)
  }
}

const isJob = (event: RuntimeEvent): event is JobEvent =>
  event.type === 'job.started' ||
  event.type === 'job.progress' ||
  event.type === 'job.updated' ||
  event.type === 'job.ended'

const callOf = (event: JobEvent): string | null => (event.type === 'job.updated' ? null : event.callId)

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
 * The subtasks of one task, folded from its messages in id order. Each subagent call is one; job
 * events and tool results about other calls, such as background shell commands, are ignored.
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
    let changed = false
    for (const event of rowEvents(row)) {
      changed = this.applyEvent(row, event) || changed
    }
    return changed
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

  private applyEvent(row: MessageRow, event: RuntimeEvent): boolean {
    if (event.type === 'tool.started') {
      return this.applyCall(row, event)
    }
    if (event.type === 'tool.ended') {
      return this.applyEnd(row, event)
    }
    return isJob(event) && this.applyJob(row, event)
  }

  private start(row: MessageRow, call: ToolCall, subagent: NonNullable<ToolCall['subagent']>, thread: string): boolean {
    if (this.byCall.has(call.callId)) {
      return false
    }
    const parent = thread === '' ? null : (this.byCall.get(thread)?.tool_use_id ?? thread)
    const draft = newDraft(row, call, subagent, parent)
    this.alias(draft, call.callId)
    if (subagent.name !== undefined) {
      this.byAgent.set(subagent.name, draft)
    }
    this.drafts.push(draft)
    return true
  }

  private applyCall(row: MessageRow, { call, thread }: EventOf<'tool.started'>): boolean {
    if (call.subagent !== undefined) {
      return this.start(row, call, call.subagent, thread)
    }
    const target = call.send === undefined ? undefined : this.byAgent.get(call.send.to)
    if (target === undefined) {
      return false
    }
    this.alias(target, call.callId)
    return true
  }

  private applyEnd(row: MessageRow, event: EventOf<'tool.ended'>): boolean {
    const draft = this.byCall.get(event.callId)
    if (draft === undefined) {
      return false
    }
    if (draft.tool_use_id === event.callId) {
      const agentId = event.result.agent?.id
      if (agentId !== undefined) {
        this.byAgent.set(agentId, draft)
      }
      Object.assign(draft, agentResultPatch(draft, row, event))
    } else if (event.status !== 'error') {
      Object.assign(draft, resumed(row))
    }
    return true
  }

  private applyJob(row: MessageRow, event: JobEvent): boolean {
    const callId = callOf(event)
    const draft = (callId === null ? undefined : this.byCall.get(callId)) ?? this.byAgent.get(event.jobId)
    if (!draft) {
      return false
    }
    this.byAgent.set(event.jobId, draft)
    if (event.type === 'job.started' && callId !== null) {
      this.alias(draft, callId)
    }
    Object.assign(draft, { live: true, sdk_task_id: event.jobId }, jobPatch(draft, row, event))
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
