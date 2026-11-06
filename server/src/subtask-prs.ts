import type { InputSubtask, SubtaskBrief } from '@seti/shared'
import { auditSubtaskPrLink } from './audit.js'
import type { CreatedPr } from './pr-link.js'
import { subtaskPrs } from './store/subtasks.js'
import { agentTodos, foldedChanges, subtaskBriefs, subtaskOf } from './subtask-cache.js'
import { publish } from './task-events.js'

type Linker = 'agent' | 'user'

export async function publishSubtasks(taskId: string, openSince: number | null): Promise<void> {
  publish(taskId, { type: 'subtasks', subtasks: await subtaskBriefs(taskId, openSince) })
}

/** Tells the task's streams what its newest messages changed: its subtasks or its todo list. */
export async function publishFolded(taskId: string, openSince: number | null): Promise<void> {
  const changed = await foldedChanges(taskId)
  if (changed.subtasks) {
    await publishSubtasks(taskId, openSince)
  }
  if (changed.todos) {
    publish(taskId, { type: 'todos', todos: await agentTodos(taskId) })
  }
}

/** Links a PR the task already has to one subagent; true when it was not linked to it before. */
export async function linkSubtaskPr(taskId: string, url: string, subtask: SubtaskBrief, actor: Linker) {
  const linked = await subtaskPrs.link(taskId, url, subtask.tool_use_id, actor)
  if (linked) {
    await auditSubtaskPrLink({ actor, taskId, url, linked: true, subtask })
  }
  return linked
}

/** Unlinks a PR from a subagent while the task keeps it; true when it was linked to it. */
export async function unlinkSubtaskPr(taskId: string, url: string, subtask: SubtaskBrief) {
  const unlinked = await subtaskPrs.unlink(taskId, url, subtask.tool_use_id)
  if (unlinked) {
    await auditSubtaskPrLink({ actor: 'user', taskId, url, linked: false, subtask })
  }
  return unlinked
}

/**
 * Links each PR a subagent opened to that subagent; the task links them first. True when a link
 * changed, after which the task's streams hear about it.
 */
export async function linkSubagentPrs(
  taskId: string,
  created: readonly CreatedPr[],
  openSince: number | null,
): Promise<boolean> {
  let changed = false
  for (const { url, parent } of created) {
    const subtask = parent === null ? null : await subtaskOf(taskId, parent, openSince)
    if (subtask !== null) {
      changed = (await linkSubtaskPr(taskId, url, subtask, 'agent')) || changed
    }
  }
  if (changed) {
    await publishSubtasks(taskId, openSince)
  }
  return changed
}

/** The subagent a PR update concerns, as the update records it; null when it is gone. */
export async function inputSubtask(
  taskId: string,
  toolUseId: string,
  openSince: number | null,
): Promise<InputSubtask | null> {
  const subtask = await subtaskOf(taskId, toolUseId, openSince)
  if (subtask === null) {
    return null
  }
  return {
    tool_use_id: subtask.tool_use_id,
    description: subtask.description,
    agent_id: subtask.sdk_task_id,
    running: subtask.status === 'running',
  }
}

/**
 * What the parent agent reads with an update about a subagent's PR. Claude Code takes no host
 * message addressed to a subagent, so the parent continues the work or hands it on itself.
 */
export function subtaskNote(subtask: InputSubtask): string {
  const id = subtask.agent_id === null ? '' : ` (agent id ${subtask.agent_id})`
  const who = `your subagent "${subtask.description}"${id}`
  const state = subtask.running ? ', which was still running when it arrived' : ''
  const target = subtask.agent_id ?? 'that subagent'
  return [
    `This update concerns the work of ${who}${state}.`,
    `Continue that work with SendMessage to ${target} if that agent is still available, or handle it yourself.`,
  ].join(' ')
}
