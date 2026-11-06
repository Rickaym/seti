import type { SDKAssistantMessage, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { BackgroundShell, BackgroundShellStatus, MessageRow, ShellStopCause } from '@seti/shared'
import { messages } from './db.js'
import { redactSecrets } from './scrub.js'

type SystemMessage = Extract<SDKMessage, { type: 'system' }>
type TaskMessage = Extract<SystemMessage, { subtype: 'task_started' | 'task_updated' | 'task_notification' }>
type Of<S extends TaskMessage['subtype']> = Extract<TaskMessage, { subtype: S }>
type UserBlock = Exclude<SDKUserMessage['message']['content'], string>[number]
type ToolResultBlock = Extract<UserBlock, { type: 'tool_result' }>

/** Tools whose commands Claude Code runs as local_bash tasks. */
const SHELL_TOOLS = new Set(['Bash', 'Monitor'])
const COMMAND_CHARS = 2000
const BACKGROUND_ID = /running in background with ID: ([\w-]+)/
const OUTPUT_PATH = /Output is being written to: (\S+?\.output)\b/
const EXIT_CODE = /\(exit code (-?\d+)\)/
/** How a task notification's summary names a stop Claude Code made on its own. */
const STOP_CAUSES: readonly (readonly [RegExp, ShellStopCause])[] = [
  [/background time limit/i, 'time_limit'],
  [/running low on memory/i, 'low_memory'],
]

type Ended = Exclude<BackgroundShellStatus, 'running'>

interface Draft {
  id: string
  tool_use_id: string
  tool: string
  command: string
  description: string | null
  background: boolean
  subagent: boolean
  /** Id of the message that started it, to tell whether the open session runs it. */
  since: number
  started_at: string
  ended: Ended | null
  ended_at: string | null
  stop_cause: ShellStopCause | null
  exit_code: number | null
  output_file: string | null
}

/** The shell's command as the agent wrote it and the tool that ran it. */
interface ShellCall {
  tool: string
  command: string
  description: string | null
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined
}

function text(value: unknown, key: string): string | null {
  const found = field(value, key)
  return typeof found === 'string' && found.trim() !== '' ? found : null
}

/** Secrets redacted and clipped, for showing a command line. */
export function displayCommand(command: string, max = COMMAND_CHARS): string {
  const redacted = redactSecrets(command)
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted
}

function resultText(block: ToolResultBlock): string {
  const { content } = block
  if (content === undefined) {
    return ''
  }
  if (typeof content === 'string') {
    return content
  }
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

const ENDED_BY_PATCH: Partial<Record<string, Ended>> = { completed: 'completed', failed: 'failed', killed: 'killed' }
const ENDED_BY_NOTICE: Record<string, Ended> = { completed: 'completed', failed: 'failed', stopped: 'killed' }

const isShellTask = (m: SystemMessage): m is TaskMessage =>
  m.subtype === 'task_started' || m.subtype === 'task_updated' || m.subtype === 'task_notification'

/** A shell without an outcome runs if the open session started it; else that session killed it. */
function statusOf(draft: Draft, openSince: number | null): BackgroundShellStatus {
  if (draft.ended !== null) {
    return draft.ended
  }
  return openSince !== null && draft.since >= openSince ? 'running' : 'killed'
}

/**
 * The background shells of one task, folded from its messages in id order. Claude Code reports
 * every Bash call as a local_bash task; only those that run in the background, from the start or
 * once moved there, are kept.
 */
export class ShellIndex {
  lastId = 0
  private readonly drafts = new Map<string, Draft>()
  /** Bash and Monitor calls waiting for the task that runs them. */
  private readonly calls = new Map<string, ShellCall>()

  /** Folds one message in; older messages are ignored. */
  apply(row: MessageRow): void {
    if (row.id <= this.lastId) {
      return
    }
    this.lastId = row.id
    if (row.kind !== 'sdk') {
      return
    }
    const m = row.payload
    if (m.type === 'assistant') {
      this.applyAssistant(m)
    } else if (m.type === 'user') {
      this.applyUser(row, m)
    } else if (m.type === 'system' && isShellTask(m)) {
      this.applyTask(row, m)
    }
  }

  /** The background shells in the order they started, the newest last. */
  shells(openSince: number | null): (BackgroundShell & { output_file: string | null })[] {
    return [...this.drafts.values()]
      .filter((draft) => draft.background)
      .map((draft) => ({
        id: draft.id,
        tool_use_id: draft.tool_use_id,
        tool: draft.tool,
        command: displayCommand(draft.command),
        description: draft.description,
        status: statusOf(draft, openSince),
        stop_cause: draft.stop_cause,
        exit_code: draft.exit_code,
        started_at: draft.started_at,
        ended_at: draft.ended_at,
        subagent: draft.subagent,
        pid: null,
        has_output: draft.output_file !== null,
        output_file: draft.output_file,
      }))
  }

  /** The commands of the shells the open session runs, as the agent wrote them, by shell id. */
  runningCommands(openSince: number | null): Map<string, string> {
    return new Map(
      [...this.drafts.values()]
        .filter((draft) => draft.background && statusOf(draft, openSince) === 'running')
        .map((draft) => [draft.id, draft.command] as const),
    )
  }

  private applyAssistant(m: SDKAssistantMessage): void {
    for (const block of m.message.content) {
      if (block.type === 'tool_use' && SHELL_TOOLS.has(block.name)) {
        this.calls.set(block.id, {
          tool: block.name,
          command: (text(block.input, 'command') ?? '').slice(0, COMMAND_CHARS * 2),
          description: text(block.input, 'description'),
        })
      }
    }
  }

  private draftOf(id: string, toolUseId: string, row: MessageRow, background: boolean): Draft | null {
    const existing = this.drafts.get(id)
    if (existing !== undefined) {
      return existing
    }
    const call = this.calls.get(toolUseId)
    if (call === undefined) {
      return null
    }
    this.calls.delete(toolUseId)
    const draft: Draft = {
      id,
      tool_use_id: toolUseId,
      tool: call.tool,
      command: call.command,
      description: call.description,
      background,
      subagent: false,
      since: row.id,
      started_at: row.created_at,
      ended: null,
      ended_at: null,
      stop_cause: null,
      exit_code: null,
      output_file: null,
    }
    this.drafts.set(id, draft)
    return draft
  }

  /** Older Claude Code versions report a background command only in its tool result. */
  private applyUser(row: MessageRow, m: SDKUserMessage): void {
    if (typeof m.message.content === 'string') {
      return
    }
    for (const block of m.message.content) {
      if (block.type !== 'tool_result') {
        continue
      }
      const body = resultText(block)
      const id = text(m.tool_use_result, 'backgroundTaskId') ?? BACKGROUND_ID.exec(body)?.[1] ?? null
      const draft = id === null ? null : this.draftOf(id, block.tool_use_id, row, true)
      this.calls.delete(block.tool_use_id)
      if (draft !== null) {
        draft.background = true
        draft.output_file ??= OUTPUT_PATH.exec(body)?.[1] ?? null
      }
    }
  }

  private applyTask(row: MessageRow, m: TaskMessage): void {
    if (m.subtype === 'task_started') {
      this.started(row, m)
      return
    }
    const draft = this.drafts.get(m.task_id)
    if (draft === undefined) {
      return
    }
    Object.assign(draft, m.subtype === 'task_updated' ? updatedPatch(draft, row, m) : notifiedPatch(draft, row, m))
    if (!draft.background && draft.ended !== null) {
      this.drafts.delete(draft.id)
    }
  }

  private started(row: MessageRow, m: Of<'task_started'>): void {
    if (m.task_type !== 'local_bash' || m.tool_use_id === undefined) {
      return
    }
    const draft = this.draftOf(m.task_id, m.tool_use_id, row, m.is_backgrounded === true)
    if (draft !== null) {
      draft.background ||= m.is_backgrounded === true
      draft.subagent = field(m, 'owned_by_subagent') === true
      draft.description ??= m.description.trim() === '' ? null : m.description
    }
  }
}

function updatedPatch(draft: Draft, row: MessageRow, m: Of<'task_updated'>): Partial<Draft> {
  const background = draft.background || m.patch.is_backgrounded === true
  const ended = ENDED_BY_PATCH[m.patch.status ?? '']
  if (ended === undefined || draft.ended !== null) {
    return { background }
  }
  const at = m.patch.end_time === undefined ? row.created_at : new Date(m.patch.end_time).toISOString()
  return { background, ended, ended_at: at }
}

function notifiedPatch(draft: Draft, row: MessageRow, m: Of<'task_notification'>): Partial<Draft> {
  const code = EXIT_CODE.exec(m.summary)?.[1]
  const cause = m.status === 'stopped' ? STOP_CAUSES.find(([pattern]) => pattern.test(m.summary)) : undefined
  return {
    ended: draft.ended ?? ENDED_BY_NOTICE[m.status] ?? 'failed',
    ended_at: draft.ended_at ?? row.created_at,
    stop_cause: cause?.[1] ?? draft.stop_cause,
    output_file: m.output_file === '' ? draft.output_file : m.output_file,
    exit_code: code === undefined ? draft.exit_code : Number(code),
  }
}

const indexes = new Map<string, ShellIndex>()
/** Catch-ups of one task run one at a time, so no message is folded in twice. */
const catchUps = new Map<string, Promise<ShellIndex>>()

/** The task's shell index, with the messages stored since the last look folded in. */
export async function shellIndex(taskId: string): Promise<ShellIndex> {
  const index = indexes.get(taskId) ?? new ShellIndex()
  indexes.set(taskId, index)
  const run = async () => {
    for (const row of await messages.after(taskId, index.lastId)) {
      index.apply(row)
    }
    return index
  }
  const next = (catchUps.get(taskId) ?? Promise.resolve(index)).then(run, run)
  catchUps.set(taskId, next)
  void next.finally(() => {
    if (catchUps.get(taskId) === next) {
      catchUps.delete(taskId)
    }
  })
  return next
}

export function forgetShells(taskId: string): void {
  indexes.delete(taskId)
}
