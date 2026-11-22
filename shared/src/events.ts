/** What a tool call does, the same on every runtime; the vendor's own name stays on the call. */
export type ToolKind =
  'shell' | 'read' | 'edit' | 'search' | 'web' | 'mcp' | 'subagent' | 'question' | 'plan' | 'think' | 'other'

/** One file a call changes: a patch where the runtime gives one, else the text it replaces. */
interface EditChange {
  path: string
  op: 'write' | 'create' | 'update' | 'delete' | 'move'
  diff?: string
  before?: string
  after?: string
  to?: string
}

type PlanStatus = 'pending' | 'in_progress' | 'completed'

interface PlanItem {
  id: string
  text: string
  activeText?: string
  status: PlanStatus
}

/** How a call changes the agent's plan: the whole list, one item added or changed, or a proposal. */
interface PlanChange {
  replace?: PlanItem[]
  add?: Omit<PlanItem, 'id'>
  update?: { id: string; status?: PlanStatus | 'deleted'; text?: string; activeText?: string }
  proposal?: string
}

interface Question {
  text: string
  header?: string
  options: string[]
  multiple?: boolean
}

/** A tool call: its kind, the vendor's name and input, and the part of the input its kind reads. */
export interface ToolCall {
  callId: string
  kind: ToolKind
  name: string
  input: unknown
  shell?: {
    action: 'run' | 'watch' | 'output' | 'stop'
    command?: string
    description?: string
    background?: boolean
    timeoutMs?: number
    job?: string
  }
  read?: { paths: string[] }
  edit?: { changes: EditChange[] }
  /** `tools` marks a search of the tools the agent can load rather than of its files. */
  search?: { pattern?: string; path?: string; tools?: boolean }
  web?: { url?: string; query?: string }
  mcp?: { server: string; tool: string }
  /** `thread` is the thread the subagent's own events carry; `name` is what messages address it by. */
  subagent?: { label: string; prompt?: string; agentType?: string; background?: boolean; name?: string; thread: string }
  /** A message to a subagent already started, addressed by its name or id. */
  send?: { to: string }
  question?: { questions: Question[] }
  plan?: PlanChange
}

/** What a subagent call returned: its id, its text without the id line, and its report once done. */
interface AgentResult {
  id?: string
  text: string
  done: boolean
  report?: string
  usage?: JobUsage
}

/** The plan as a call's result reports it: the whole list, one item, or that nothing changed. */
interface PlanReport {
  items?: PlanItem[]
  item?: { id: string; status: PlanStatus; text?: string }
  unchanged?: boolean
}

/**
 * What a call returned. `job` is set when its work went on in the background; `planId` names the
 * plan item it created; `structured` is the vendor's structured output, unchanged.
 */
export interface ToolResult {
  text: string
  images: number
  exitCode?: number
  job?: { id: string | null; output?: string }
  agent?: AgentResult
  planId?: string
  plan?: PlanReport
  structured?: unknown
}

type JobKind = 'subagent' | 'shell' | 'other'

export interface JobUsage {
  tokens: number
  toolUses: number
  durationMs: number
}

interface Usage {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  reasoning?: number
}

type TurnCause = 'input' | 'background'

type TurnEnding = 'error' | 'turn_limit' | 'budget_limit' | 'retry_limit' | 'other'

/** `thread` is empty for the agent itself, else the id of the subagent thread it belongs to. */
interface EventBase {
  v: 1
  thread: string
}

/** One thing a runtime reported, the same on every runtime; `vendor` stands for anything unmapped. */
export type RuntimeEvent = EventBase &
  (
    | { type: 'session.started'; sessionId: string; model: string; mode: string | null; servers: ServerStatus[] }
    | { type: 'turn.started'; turnId: string; cause: TurnCause }
    | { type: 'message'; id: string; role: 'agent' | 'user' | 'command'; text: string; synthetic?: boolean }
    | { type: 'reasoning'; id: string; text: string; summary: boolean }
    | { type: 'tool.started'; call: ToolCall }
    | { type: 'tool.progress'; callId: string; elapsedMs: number }
    | { type: 'tool.ended'; callId: string; status: 'ok' | 'error' | 'denied' | 'cancelled'; result: ToolResult }
    | { type: 'plan'; items: PlanItem[] }
    | {
        type: 'job.started'
        jobId: string
        callId: string | null
        kind: JobKind
        label: string
        background?: boolean
        agentType?: string
        /** A subagent, not the agent itself, started it. */
        bySubagent?: boolean
      }
    | {
        type: 'job.progress'
        jobId: string
        callId: string | null
        label: string
        lastTool?: string
        summary?: string
        usage: JobUsage
      }
    | { type: 'job.updated'; jobId: string; status?: string; background?: boolean; endedAt?: string; error?: string }
    | {
        type: 'job.ended'
        jobId: string
        callId: string | null
        status: 'completed' | 'failed' | 'stopped'
        summary: string
        output?: string
        exitCode?: number
        /** Why the runtime stopped it on its own. */
        stopCause?: 'time_limit' | 'low_memory'
        usage?: JobUsage
      }
    | { type: 'background.changed'; jobs: { id: string; kind: JobKind; label: string }[] }
    | { type: 'usage'; usage: Usage; contextWindow?: number }
    | {
        type: 'compaction'
        phase: 'started' | 'stopped' | 'done' | 'failed'
        trigger?: 'auto' | 'manual'
        before?: number
        /** The context window `before` was measured against, in tokens, where known. */
        window?: number
        error?: string
      }
    | { type: 'model.changed'; from: string; to: string; reason: 'user' | 'fallback' | 'refusal'; text?: string }
    | {
        type: 'policy.denied'
        callId: string
        tool: string
        by: 'runtime'
        /** An automatic safety classifier turned it down, not a rule or the mode. */
        classifier?: boolean
        /** The reason the deciding check gave, where it gave one. */
        reason?: string
        /** What the agent was told. */
        text: string
      }
    | { type: 'change.published'; url: string; action: string }
    | { type: 'notice'; code: NoticeCode; text: string; status?: number }
    | {
        type: 'turn.ended'
        turnId: string
        status: 'ok' | 'error' | 'interrupted'
        result: string
        error?: string
        /** Why a turn stopped short of its answer; absent for a turn that ran to its end. */
        ending?: TurnEnding
        cause: TurnCause
        steps?: number
        costUsd?: number
        durationMs?: number
        usage?: Usage
        answered: string[]
        apiStatus?: number
      }
    /** `unreadable` marks a message of a known type whose shape the projector could not read. */
    | { type: 'vendor'; name: string; unreadable?: true }
  )

interface ServerStatus {
  name: string
  status: string
}

type NoticeCode = 'api_retry' | 'rate_limited' | 'auth' | 'interrupted' | 'info'
