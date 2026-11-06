import type { AgentProcess, AgentProcesses } from '@seti/shared'
import { forgetProcesses, readProcesses, shellOutput, stoppable, subtreeOf, terminate } from './agent-processes.js'
import { auditTask } from './audit.js'
import { shellIndex } from './background-shells.js'
import { refuseOtherAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import {
  appendMessage,
  autoQueueBlocker,
  isRunning,
  openQuerySince,
  runAutoTurn,
  stopSessionTask,
  type TurnPreface,
} from './runner.js'
import { stoppedNotes } from './store/processes.js'
import { inLane } from './task-lane.js'
import { requireTask } from './tasks.js'

/** How long Claude Code gets to stop a shell before Seti signals its processes itself. */
const SDK_STOP_MS = 5000

const firstWord = (command: string) => command.trim().split(/\s+/)[0] ?? ''

/** A fresh reading, which the next poll gets too instead of the cached one. */
async function current(taskId: string) {
  forgetProcesses(taskId)
  return readProcesses(taskId, openQuerySince(taskId))
}

async function requireShell(taskId: string, shellId: string) {
  const shell = (await shellIndex(taskId)).shells(openQuerySince(taskId)).find((s) => s.id === shellId)
  if (shell === undefined) {
    throw new HttpError(404, 'Background shell not found')
  }
  return shell
}

/** Tells the agent what the user stopped: now when a turn runs, else with its next message. */
async function noteStopped(taskId: string, note: string): Promise<void> {
  await inLane(taskId, async () => appendMessage(taskId, { kind: 'seti', payload: { error: note, stopped: true } }))
  if (isRunning(taskId) && autoQueueBlocker(taskId) === null) {
    await runAutoTurn(taskId, 'next').catch((e: unknown) => {
      process.stderr.write(`could not tell task ${taskId} about a stopped process: ${String(e)}\n`)
    })
  }
}

/** What the user stopped since the agent last read a message, so it does not start them again. */
export async function stoppedPreface(taskId: string): Promise<TurnPreface | null> {
  const notes = await stoppedNotes.sinceLastTurn(taskId)
  if (notes.length === 0) {
    return null
  }
  return { text: ['The user stopped these processes from Seti:', ...notes].join('\n'), count: notes.length }
}

const processLabel = (target: AgentProcess) => `process ${String(target.ns_pid ?? target.pid)} (${target.name})`

/** Stops a process of the task and everything it started; refuses anything outside its tree. */
export async function stopProcess(taskId: string, pid: number, startTicks: number): Promise<AgentProcesses> {
  refuseOtherAgent(taskId)
  const task = await requireTask(taskId)
  const { view } = await current(task.id)
  const target = stoppable(view.processes, pid, startTicks)
  await terminate(subtreeOf(view.processes, target))
  await auditTask('task.process_stopped', task, { pid: target.pid, process: target.name })
  const shell = target.shell_id === null ? '' : ` of background shell ${target.shell_id}`
  await noteStopped(task.id, `Stopped ${processLabel(target)}${shell} at the user's request.`)
  return (await current(task.id)).view
}

/**
 * Stops a background shell through Claude Code, which keeps its own state straight; when the
 * session cannot, signals the shell's processes and notes it for the agent.
 */
export async function stopShell(taskId: string, shellId: string): Promise<AgentProcesses> {
  refuseOtherAgent(taskId)
  const task = await requireTask(taskId)
  const shell = await requireShell(task.id, shellId)
  if (shell.status !== 'running') {
    throw new HttpError(409, 'That background shell is not running')
  }
  const detail = { shell: shell.id, process: firstWord(shell.command) }
  const timeout = new Promise<boolean>((resolve) => setTimeout(resolve, SDK_STOP_MS, false).unref())
  const viaSdk = await Promise.race([stopSessionTask(task.id, shell.id).catch(() => false), timeout])
  if (!viaSdk) {
    const { view } = await current(task.id)
    const tops = view.processes.filter(
      (p) => p.shell_id === shell.id && !view.processes.some((q) => q.pid === p.ppid && q.shell_id === shell.id),
    )
    if (tops.length === 0) {
      throw new HttpError(409, 'Claude Code could not stop that shell and Seti cannot find its process')
    }
    await terminate(tops.flatMap((top) => subtreeOf(view.processes, top)))
    await noteStopped(
      task.id,
      `Stopped background shell ${shell.id} (${shell.description ?? firstWord(shell.command)}) at the user's request.`,
    )
  }
  await auditTask('task.process_stopped', task, detail)
  return (await current(task.id)).view
}

export async function readShellOutput(taskId: string, shellId: string) {
  const task = await requireTask(taskId)
  return shellOutput(task.id, await requireShell(task.id, shellId))
}
