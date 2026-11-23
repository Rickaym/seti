import type { RuntimeEvent } from '../../events.js'
import { unwrapShell } from './calls.js'
import { backgroundList, commandExecution, itemParams } from './shapes.js'

type Event = RuntimeEvent

/** A command Codex runs in the background, as a stored row names it beside Codex's message. */
export interface CodexJob {
  /** Codex's process id for the background terminal. */
  id: string
  /** Seti asked Codex to stop it. */
  stopped?: boolean | undefined
}

/** Codex's list of background terminals, as jobs that run on after their call. */
export function jobsStarted(reply: unknown, thread: string): Event[] {
  return backgroundList.parse(reply).data.map((terminal) => ({
    v: 1,
    thread,
    type: 'job.started',
    jobId: terminal.processId,
    callId: terminal.itemId,
    kind: 'shell',
    label: unwrapShell(terminal.command),
    background: true,
  }))
}

/** The end of a background command: Codex completes its item once the process exits. */
export function jobEnded(params: unknown, job: CodexJob, thread: string): Event {
  const raw = itemParams.parse(params).item
  const item = commandExecution.parse(raw)
  const output = item.aggregatedOutput ?? ''
  const exit = typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}
  const ended = {
    v: 1,
    thread,
    type: 'job.ended',
    jobId: job.id,
    callId: raw.id,
    summary: output,
    output,
    ...exit,
  } as const
  return { ...ended, status: job.stopped === true ? 'stopped' : statusOf(item) }
}

function statusOf(item: { status: string; exitCode?: number | null | undefined }): 'completed' | 'failed' {
  return item.status === 'completed' && (item.exitCode ?? 0) === 0 ? 'completed' : 'failed'
}
