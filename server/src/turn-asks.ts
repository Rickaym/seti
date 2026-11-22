import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { NodeAnswer, NodeAsk, Task } from '@seti/shared'
import { audit } from './audit.js'
import { effectiveCompact } from './compact.js'
import { tasks } from './db.js'
import { askAboutRepeat, canUseToolFor } from './permission-requests.js'
import { repeatReason } from './repeat-guard.js'
import { reviewCall } from './review-hooks.js'
import { redactSecrets } from './scrub.js'
import { callSessionTool, listSessionTools } from './session-tools.js'
import { archiveSettings } from './store/archive.js'
import { allowedFor } from './store/change-requests.js'

type AskOptions = Parameters<CanUseTool>[2]

async function taskOf(taskId: string): Promise<Task> {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new Error('This agent no longer exists in Seti.')
  }
  return task
}

/** Records that the agent repeats a call, then asks the user whether it may go on. */
async function repeatCall(taskId: string, { tool, input, results }: NodeAsk<'repeat.ask'>, signal: AbortSignal) {
  if (!(await archiveSettings.get()).repeat_guard) {
    return { outcome: 'off' } as const
  }
  const task = await taskOf(taskId)
  const reason = repeatReason(tool, results)
  await audit.record({
    actor: 'system',
    kind: 'task.repeat_stopped',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Stopped task "${task.title}" to ask the user: ${reason}`,
    detail: { title: task.title, tool, results },
  })
  const answer = await askAboutRepeat(taskId, { tool, input }, reason, [signal])
  if (answer.behavior === 'deny') {
    return { outcome: 'denied', message: answer.message } as const
  }
  return { outcome: 'allowed', always: answer.decisionClassification === 'user_permanent' } as const
}

const COMMAND_CHARS = 500

/** The guard's refusals go to the audit log, so the user sees what an agent tried. */
export async function auditRefusal(taskId: string, command: string, reason: string): Promise<void> {
  const task = await taskOf(taskId)
  const shown = redactSecrets(command).slice(0, COMMAND_CHARS)
  await audit.record({
    actor: 'system',
    kind: 'task.permission_denied',
    subject_type: 'task',
    subject_id: task.id,
    summary: `Refused a command of task "${task.title}": ${reason}`,
    detail: { title: task.title, tool: 'Bash', command: shown, guard: true },
  })
}

/** What the control plane answers a node while one of the agent's turns waits on it. */
export const turnAnswers = {
  'permission.ask': async (
    taskId: string,
    { tool, input, options }: NodeAsk<'permission.ask'>,
    signal: AbortSignal,
  ): Promise<NodeAnswer<'permission.ask'>> => {
    // The node handed on the runtime's own options, without their signal.
    const asked = { ...(options as Omit<AskOptions, 'signal'>), signal }
    return { result: await canUseToolFor(taskId, signal)(tool, input, asked) }
  },
  'review.ask': async (taskId: string, call: NodeAsk<'review.ask'>, signal: AbortSignal) => ({
    output: await reviewCall(await taskOf(taskId), call, signal),
  }),
  'repeat.ask': async (taskId: string, ask: NodeAsk<'repeat.ask'>, signal: AbortSignal) =>
    repeatCall(taskId, ask, signal),
  'hook.compact': async (taskId: string) => ({ instructions: (await effectiveCompact(taskId)).instructions }),
  'sandbox.hosts': async (taskId: string) => ({ hosts: await allowedFor(taskId) }),
  'tools.list': async (taskId: string) => listSessionTools(await taskOf(taskId)),
  'tool.call': async (taskId: string, call: NodeAsk<'tool.call'>, signal: AbortSignal) =>
    callSessionTool(taskId, call, signal),
}
