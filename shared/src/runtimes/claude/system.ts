import type {
  SDKBackgroundTasksChangedMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeEvent } from '../../events.js'
import { list, some, str } from './fields.js'

type SystemMessage = Extract<SDKMessage, { type: 'system' }>
type Of<S extends SystemMessage['subtype']> = Extract<SystemMessage, { subtype: S }>
type Event = RuntimeEvent

const EXIT_CODE = /\(exit code (-?\d+)\)/

const base = { v: 1, thread: '' } as const

/** Claude Code's task types: a background command, a subagent here or remote, or something else. */
function jobKind(taskType: string | undefined): 'subagent' | 'shell' | 'other' {
  if (taskType === 'local_bash') {
    return 'shell'
  }
  return taskType === 'local_agent' || taskType === 'remote_agent' ? 'subagent' : 'other'
}

const jobUsage = (usage: { total_tokens: number; tool_uses: number; duration_ms: number }) => ({
  tokens: usage.total_tokens,
  toolUses: usage.tool_uses,
  durationMs: usage.duration_ms,
})

const started = (m: SDKTaskStartedMessage): Event => ({
  ...base,
  type: 'job.started',
  jobId: m.task_id,
  callId: m.tool_use_id ?? null,
  kind: jobKind(m.task_type),
  label: m.description,
  ...some('background', m.is_backgrounded),
})

const progressed = (m: SDKTaskProgressMessage): Event => ({
  ...base,
  type: 'job.progress',
  jobId: m.task_id,
  callId: m.tool_use_id ?? null,
  label: m.description,
  ...some('lastTool', m.last_tool_name),
  usage: jobUsage(m.usage),
})

const endTime = (ms: number | undefined) => {
  const at = ms === undefined ? Number.NaN : new Date(ms).getTime()
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined
}

const updated = (m: SDKTaskUpdatedMessage): Event => ({
  ...base,
  type: 'job.updated',
  jobId: m.task_id,
  ...some('status', m.patch.status),
  ...some('endedAt', endTime(m.patch.end_time)),
  ...some('error', m.patch.error),
})

function ended(m: SDKTaskNotificationMessage): Event {
  const code = EXIT_CODE.exec(m.summary)?.[1]
  return {
    ...base,
    type: 'job.ended',
    jobId: m.task_id,
    callId: m.tool_use_id ?? null,
    status: m.status,
    summary: m.summary,
    ...some('output', m.output_file),
    ...some('exitCode', code === undefined ? undefined : Number(code)),
    ...some('usage', m.usage === undefined ? undefined : jobUsage(m.usage)),
  }
}

const background = (m: SDKBackgroundTasksChangedMessage): Event => ({
  ...base,
  type: 'background.changed',
  jobs: m.tasks.map((task) => ({ id: task.task_id, kind: jobKind(task.task_type), label: task.description })),
})

/** A session start; older stored starts may lack the mode or the server list. */
const init = (m: Of<'init'>): Event => ({
  ...base,
  type: 'session.started',
  sessionId: m.session_id,
  model: m.model,
  mode: str(m, 'permissionMode') ?? null,
  servers: list(m, 'mcp_servers').map((server) => ({
    name: str(server, 'name') ?? '',
    status: str(server, 'status') ?? '',
  })),
})

/** A status says compaction began, failed, or stopped; any other status ends a running one. */
function status(m: Of<'status'>): Event {
  if (m.status === 'compacting') {
    return { ...base, type: 'compaction', phase: 'started' }
  }
  if (m.compact_result === 'failed') {
    return { ...base, type: 'compaction', phase: 'failed', error: m.compact_error ?? 'no reason given' }
  }
  return { ...base, type: 'compaction', phase: 'stopped' }
}

const compacted = (m: Of<'compact_boundary'>): Event => ({
  ...base,
  type: 'compaction',
  phase: 'done',
  trigger: m.compact_metadata.trigger,
  before: m.compact_metadata.pre_tokens,
})

const retry = (m: Of<'api_retry'>): Event => ({
  ...base,
  type: 'notice',
  code: 'api_retry',
  text: m.error,
  ...some('status', m.error_status),
})

const fallback = (m: Of<'model_refusal_fallback'>): Event => ({
  ...base,
  type: 'model.changed',
  from: m.original_model,
  to: m.fallback_model,
  reason: 'refusal',
  text: m.content,
})

const denied = (m: Of<'permission_denied'>): Event => ({
  ...base,
  type: 'policy.denied',
  callId: m.tool_use_id,
  tool: m.tool_name,
  by: 'runtime',
  reason: m.decision_reason ?? m.message,
})

const commandOutput = (m: Of<'local_command_output'>): Event => ({
  ...base,
  type: 'message',
  id: m.uuid,
  role: 'command',
  text: m.content,
})

type Handled =
  | 'init'
  | 'status'
  | 'compact_boundary'
  | 'api_retry'
  | 'model_refusal_fallback'
  | 'permission_denied'
  | 'local_command_output'
  | 'task_started'
  | 'task_progress'
  | 'task_updated'
  | 'task_notification'
  | 'background_tasks_changed'

const HANDLERS: { [S in Handled]: (m: Of<S>) => Event } = {
  init,
  status,
  compact_boundary: compacted,
  api_retry: retry,
  model_refusal_fallback: fallback,
  permission_denied: denied,
  local_command_output: commandOutput,
  task_started: started,
  task_progress: progressed,
  task_updated: updated,
  task_notification: ended,
  background_tasks_changed: background,
}

const isHandled = (subtype: string): subtype is Handled => Object.hasOwn(HANDLERS, subtype)

/** The event of one Claude Code system message; a subtype Seti does not read is `vendor`. */
export function systemEvent(m: SystemMessage): Event {
  if (!isHandled(m.subtype)) {
    return { ...base, type: 'vendor', name: `system/${m.subtype}` }
  }
  const handler = HANDLERS[m.subtype] as (message: SystemMessage) => Event
  return handler(m)
}
