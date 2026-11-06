import { SHELL_CONTEXT_RUNS, type ShellResult } from '@seti/shared'
import type { TurnPreface } from './runner.js'
import { shellRuns } from './store/shell.js'

const CONTEXT_STREAM_CHARS = 3000

const busy = new Set<string>()

/** Task ids with a running `!` command, kept by shell.ts so the runner can refuse turns. */
export const shellBusy = {
  start: (taskId: string) => busy.add(taskId),
  end: (taskId: string) => busy.delete(taskId),
}

/** Why an agent turn cannot start while a `!` command runs in the task, or null when it can. */
export const shellTurnGuard = (taskId: string) =>
  busy.has(taskId) ? 'A shell command is running for this agent; wait for it or stop it' : null

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) {
    return text
  }
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n[... ${String(text.length - 2 * half)} characters omitted ...]\n${text.slice(-half)}`
}

function describeRun(run: ShellResult): string {
  const status = run.ended_by === null ? String(run.exit_code ?? run.signal ?? 'none') : `ended by ${run.ended_by}`
  return [
    `<bash-input>${run.command}</bash-input>`,
    `<bash-exit-code>${status}</bash-exit-code>`,
    `<bash-stdout>${clipMiddle(run.stdout, CONTEXT_STREAM_CHARS)}</bash-stdout>`,
    `<bash-stderr>${clipMiddle(run.stderr, CONTEXT_STREAM_CHARS)}</bash-stderr>`,
  ].join('\n')
}

/** Shell runs since the agent last read a message; slash commands pass them on to the next turn. */
export async function shellPreface(taskId: string): Promise<TurnPreface | null> {
  const pending = await shellRuns.sinceLastTurn(taskId, SHELL_CONTEXT_RUNS)
  if (pending.length === 0) {
    return null
  }
  const cwd = pending.at(-1)?.cwd ?? ''
  const text = [
    `The user ran these commands in the task directory (${cwd}) since your last turn:`,
    ...pending.map(describeRun),
  ].join('\n\n')
  return { text, count: pending.length }
}
