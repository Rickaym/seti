import type { BackgroundShell, BackgroundShellStatus, MessageRow, ShellStopCause } from '@seti/shared'
import { nonBlank, rowEvents, type Of } from './events/read.js'
import { eachMessageAfter } from './message-pages.js'
import { redactSecrets } from './scrub.js'

const COMMAND_CHARS = 2000

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

/** Secrets redacted and clipped, for showing a command line. */
export function displayCommand(command: string, max = COMMAND_CHARS): string {
  const redacted = redactSecrets(command)
  return redacted.length > max ? `${redacted.slice(0, max - 3)}...` : redacted
}

const ENDED_BY_PATCH: Partial<Record<string, Ended>> = { completed: 'completed', failed: 'failed', killed: 'killed' }
const ENDED_BY_NOTICE: Record<Of<'job.ended'>['status'], Ended> = {
  completed: 'completed',
  failed: 'failed',
  stopped: 'killed',
}

/** A shell without an outcome runs if the open session started it; else that session killed it. */
function statusOf(draft: Draft, openSince: number | null): BackgroundShellStatus {
  if (draft.ended !== null) {
    return draft.ended
  }
  return openSince !== null && draft.since >= openSince ? 'running' : 'killed'
}

/**
 * The background shells of one task, folded from its messages in id order. The runtime reports
 * every shell call as a job; only those that run in the background, from the start or once moved
 * there, are kept.
 */
export class ShellIndex {
  lastId = 0
  private readonly drafts = new Map<string, Draft>()
  /** Shell calls that run or watch a command, waiting for the job that runs them. */
  private readonly calls = new Map<string, ShellCall>()

  /** Folds one message in; older messages are ignored. */
  apply(row: MessageRow): void {
    if (row.id <= this.lastId) {
      return
    }
    this.lastId = row.id
    for (const event of rowEvents(row)) {
      if (event.type === 'tool.started') {
        this.applyCall(event)
      } else if (event.type === 'tool.ended') {
        this.applyEnd(row, event)
      } else if (event.type === 'job.started') {
        this.started(row, event)
      } else if (event.type === 'job.updated' || event.type === 'job.ended') {
        this.applyJob(row, event)
      }
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

  private applyCall({ call }: Of<'tool.started'>): void {
    const shell = call.shell
    if (shell?.action === 'run' || shell?.action === 'watch') {
      this.calls.set(call.callId, {
        tool: call.name,
        command: (nonBlank(shell.command) ?? '').slice(0, COMMAND_CHARS * 2),
        description: nonBlank(shell.description),
      })
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

  /** Older runtimes report a background command only in its tool result. */
  private applyEnd(row: MessageRow, event: Of<'tool.ended'>): void {
    const { job } = event.result
    const id = job?.id ?? null
    const draft = id === null ? null : this.draftOf(id, event.callId, row, true)
    this.calls.delete(event.callId)
    if (draft !== null) {
      draft.background = true
      draft.output_file ??= job?.output ?? null
    }
  }

  private applyJob(row: MessageRow, event: Of<'job.updated'> | Of<'job.ended'>): void {
    const draft = this.drafts.get(event.jobId)
    if (draft === undefined) {
      return
    }
    Object.assign(draft, event.type === 'job.updated' ? updatedPatch(draft, row, event) : endedPatch(draft, row, event))
    if (!draft.background && draft.ended !== null) {
      this.drafts.delete(draft.id)
    }
  }

  private started(row: MessageRow, event: Of<'job.started'>): void {
    if (event.kind !== 'shell' || event.callId === null) {
      return
    }
    const draft = this.draftOf(event.jobId, event.callId, row, event.background === true)
    if (draft !== null) {
      draft.background ||= event.background === true
      draft.subagent = event.bySubagent === true
      draft.description ??= nonBlank(event.label)
    }
  }
}

function updatedPatch(draft: Draft, row: MessageRow, event: Of<'job.updated'>): Partial<Draft> {
  const background = draft.background || event.background === true
  const ended = ENDED_BY_PATCH[event.status ?? '']
  if (ended === undefined || draft.ended !== null) {
    return { background }
  }
  return { background, ended, ended_at: event.endedAt ?? row.created_at }
}

function endedPatch(draft: Draft, row: MessageRow, event: Of<'job.ended'>): Partial<Draft> {
  return {
    ended: draft.ended ?? ENDED_BY_NOTICE[event.status],
    ended_at: draft.ended_at ?? row.created_at,
    stop_cause: event.stopCause ?? draft.stop_cause,
    output_file: event.output ?? draft.output_file,
    exit_code: event.exitCode ?? draft.exit_code,
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
    await eachMessageAfter(taskId, index.lastId, (row) => {
      index.apply(row)
    })
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
