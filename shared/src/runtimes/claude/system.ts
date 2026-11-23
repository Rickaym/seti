import type {
  SDKBackgroundTasksChangedMessage,
  SDKMessage,
  SDKTaskNotificationMessage,
  SDKTaskProgressMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { CONTEXT_WINDOW_KEY } from '../../compact.js'
import type { Refusal, RuntimeEvent } from '../../events.js'
import { modelFallbackOf } from '../../model-fallback.js'
import { bool, list, num, some, str } from './fields.js'

type SystemMessage = Extract<SDKMessage, { type: 'system' }>
type Of<S extends SystemMessage['subtype']> = Extract<SystemMessage, { subtype: S }>
type Event = RuntimeEvent

const EXIT_CODE = /\(exit code (-?\d+)\)/
/** How a task notification's summary names a stop Claude Code made on its own. */
const STOP_CAUSES: readonly (readonly [RegExp, 'time_limit' | 'low_memory'])[] = [
  [/background time limit/i, 'time_limit'],
  [/running low on memory/i, 'low_memory'],
]

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
  ...some('agentType', m.subagent_type),
  ...(bool(m, 'owned_by_subagent') === true ? { bySubagent: true } : {}),
})

const progressed = (m: SDKTaskProgressMessage): Event => ({
  ...base,
  type: 'job.progress',
  jobId: m.task_id,
  callId: m.tool_use_id ?? null,
  label: m.description,
  ...some('lastTool', m.last_tool_name),
  ...some('summary', m.summary),
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
  ...some('background', m.patch.is_backgrounded),
  ...some('endedAt', endTime(m.patch.end_time)),
  ...some('error', m.patch.error),
})

function ended(m: SDKTaskNotificationMessage): Event {
  const code = EXIT_CODE.exec(m.summary)?.[1]
  const cause = m.status === 'stopped' ? STOP_CAUSES.find(([pattern]) => pattern.test(m.summary)) : undefined
  return {
    ...base,
    type: 'job.ended',
    jobId: m.task_id,
    callId: m.tool_use_id ?? null,
    status: m.status,
    summary: m.summary,
    ...some('output', m.output_file === '' ? undefined : m.output_file),
    ...some('exitCode', code === undefined ? undefined : Number(code)),
    ...some('stopCause', cause?.[1]),
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
  cwd: str(m, 'cwd') ?? '',
  plugins: list(m, 'plugins').map((plugin) => ({
    name: str(plugin, 'name') ?? '',
    path: str(plugin, 'path') ?? '',
    ...some('version', str(plugin, 'version')),
  })),
  pluginErrors: list(m, 'plugin_errors').map((error) => ({
    plugin: str(error, 'plugin') ?? '',
    message: str(error, 'message') ?? '',
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
  ...some('after', m.compact_metadata.post_tokens),
  ...some('durationMs', m.compact_metadata.duration_ms),
  ...some('window', num(m, CONTEXT_WINDOW_KEY)),
})

const retry = (m: Of<'api_retry'>): Event => ({
  ...base,
  type: 'notice',
  code: 'api_retry',
  text: m.error,
  ...some('status', m.error_status),
})

/** What the safeguard said, from a fallback notice that has the fields the notice shows. */
function refusalOf(m: unknown): Refusal | undefined {
  const parsed = modelFallbackOf(m)
  if (parsed === null) {
    return undefined
  }
  const verification = parsed.api_refusal_cyber_verification
  return {
    requestId: parsed.request_id,
    ...some('scope', parsed.scope),
    ...some('category', parsed.api_refusal_category),
    ...some('explanation', parsed.api_refusal_explanation),
    ...(verification === null || verification === undefined ? {} : { verification: some('url', verification.url) }),
  }
}

const fallback = (m: Of<'model_refusal_fallback'>): Event => ({
  ...base,
  type: 'model.changed',
  from: m.original_model,
  to: m.fallback_model,
  reason: 'refusal',
  text: m.content,
  ...some('refusal', refusalOf(m)),
})

const denied = (m: Of<'permission_denied'>): Event => ({
  ...base,
  type: 'policy.denied',
  callId: m.tool_use_id,
  tool: m.tool_name,
  by: 'runtime',
  ...(m.decision_reason_type === 'classifier' ? { classifier: true } : {}),
  ...some('reason', m.decision_reason),
  text: m.message,
})

/** Claude Code's own report that the session opened a PR or pushed to one; not in the SDK types. */
function published(m: SystemMessage): Event | null {
  const url = str(m, 'url')
  return url === undefined ? null : { ...base, type: 'change.published', url, action: str(m, 'action') ?? '' }
}

type Handled =
  | 'init'
  | 'status'
  | 'compact_boundary'
  | 'api_retry'
  | 'model_refusal_fallback'
  | 'permission_denied'
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
  task_started: started,
  task_progress: progressed,
  task_updated: updated,
  task_notification: ended,
  background_tasks_changed: background,
}

const isHandled = (subtype: string): subtype is Handled => Object.hasOwn(HANDLERS, subtype)

/** The event of one Claude Code system message; a subtype Seti does not read is `vendor`. */
export function systemEvent(m: SystemMessage): Event {
  const change = (m.subtype as string) === 'code_change_published' ? published(m) : null
  if (change !== null) {
    return change
  }
  if (!isHandled(m.subtype)) {
    return { ...base, type: 'vendor', name: `system/${m.subtype}` }
  }
  const handler = HANDLERS[m.subtype] as (message: SystemMessage) => Event
  return handler(m)
}
