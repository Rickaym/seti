import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Task } from '@seti/shared'
import { inProcessDecisions } from './session-decisions.js'
import { realiseSpec, sandboxOf, scopeOf } from './session-realise.js'
import { sandboxSpec, sessionSpec, taskCaps } from './session-spec.js'
import type { TaskSandbox } from './task-sandbox.js'

/** The task's sandbox, with its plugins and shared tools read-only, or null when it runs without. */
export async function sandboxFor(task: Task): Promise<TaskSandbox | null> {
  const spec = await sandboxSpec(task)
  if (spec === null) {
    return null
  }
  const scope = await scopeOf(task.id, await taskCaps(task.id))
  return sandboxOf(task, spec, scope?.cap ?? null)
}

/** The options a task's Claude Code process starts with, resuming the task's session if any. */
export const sessionOptions = async (task: Task, abortController: AbortController): Promise<Options> =>
  realiseSpec((await sessionSpec(task)).spec, abortController, inProcessDecisions)

/** The options a process starts with and the setupKey of what it got, from one read of the setup. */
export async function sessionStart(task: Task, abortController: AbortController) {
  const { key, spec } = await sessionSpec(task)
  return { key, options: await realiseSpec(spec, abortController, inProcessDecisions) }
}
