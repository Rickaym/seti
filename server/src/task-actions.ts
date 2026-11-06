import {
  listedSubtasks,
  prStates,
  sendMessageInput,
  type SendMessageInput,
  type Subtask,
  type Task,
  type TaskListEntry,
  type updateTaskInput,
  type WorkspaceEntry,
} from '@seti/shared'
import type { z } from 'zod'
import { awaitTurnEnd, dropWait } from './agent-waits.js'
import { removeTaskFiles } from './archive-files.js'
import { auditMessage, auditTask } from './audit.js'
import { sendKey, sendOnce } from './client-sends.js'
import { messages, tasks } from './db.js'
import { retryLastPrompt } from './dropped-prompt.js'
import { refuseOtherAgent, refusePromptAsUser } from './ea-guard.js'
import { HttpError } from './http.js'
import { setInputMode } from './inputs.js'
import { slashRefusal } from './mods/commands.js'
import { setTaskNotificationsMuted } from './notifications.js'
import { endSession, openQuerySince, removeQueued, runTurn, sessionState, stopSessionTask } from './runner.js'
import { changeSetiControl } from './seti-control-note.js'
import { closeAgentChats } from './side-chat/chats.js'
import { prWatch } from './store/pr-watch.js'
import { workspaceRows } from './store/workspaces.js'
import { agentTodos, forgetSubtasks, subtaskBriefs, subtaskOf } from './subtask-cache.js'
import { linkSubtaskPr, publishSubtasks, unlinkSubtaskPr } from './subtask-prs.js'
import { setTaskCwd } from './task-location.js'
import {
  linkTaskPr,
  renameTask,
  requireTask,
  setTaskColor,
  setTaskPinned,
  setTaskProfile,
  setTaskSandbox,
} from './tasks.js'
import { endAgentTerminals } from './terminal.js'
import { placeAttachments, refuseCommandAttachments } from './uploads.js'
import { countWorkspaces, setTaskWorkspace } from './workspaces.js'

/** Most rows yield no line or share one with a tool result, so read several rows per line. */
export { stopTask, taskDigest, transcriptPage } from './task-transcript.js'

/** Every agent that is not archived, with the states of the PRs linked to it or its subagents. */
export async function taskListEntries(): Promise<TaskListEntry[]> {
  const [list, states] = await Promise.all([tasks.list(), prWatch.allTaskStates()])
  return Promise.all(
    list.map(async (task) => {
      const subtasks = await subtaskBriefs(task.id, openQuerySince(task.id))
      const shown = new Set([...task.pr_urls, ...subtasks.flatMap((subtask) => subtask.pr_urls)])
      return {
        ...task,
        ...listedSubtasks(subtasks),
        todos: await agentTodos(task.id),
        pr_states: prStates(states.get(task.id) ?? {}, shown),
      }
    }),
  )
}

/** Every workspace with its counts of active agents and of agents that need the user. */
export async function listWorkspaces(): Promise<WorkspaceEntry[]> {
  const [list, agents] = await Promise.all([workspaceRows.list(), taskListEntries()])
  return countWorkspaces(list, agents)
}

/** Applies each field the change carries, as the agent's settings do one at a time. */
export async function updateTask(id: string, input: z.output<typeof updateTaskInput>): Promise<Task> {
  refuseOtherAgent(id)
  const changes: [unknown, (task: Task) => Promise<void>][] = [
    [input.pinned, async (task) => setTaskPinned(task, input.pinned ?? task.pinned)],
    [input.title, async (task) => renameTask(task, input.title ?? task.title)],
    [input.input_mode, async (task) => setInputMode(task, input.input_mode ?? task.input_mode)],
    [input.sandbox, async (task) => setTaskSandbox(task, input.sandbox ?? task.sandbox)],
    [input.cwd, async (task) => setTaskCwd(task, input.cwd ?? task.cwd)],
    [input.profile_id, async (task) => setTaskProfile(task, input.profile_id ?? task.profile_id)],
    [input.seti_control, async (task) => changeSetiControl(task, input.seti_control ?? task.seti_control)],
    [input.color, async (task) => setTaskColor(task, input.color === undefined ? task.color : input.color)],
    [input.workspace_id, async (task) => setTaskWorkspace(task, input.workspace_id ?? task.workspace_id)],
    [
      input.notifications_muted,
      async (task) => setTaskNotificationsMuted(task, input.notifications_muted ?? task.notifications_muted),
    ],
  ]
  for (const [value, apply] of changes) {
    if (value !== undefined) {
      await apply(await requireTask(id))
    }
  }
  return requireTask(id)
}

/** Sends a message to the task's agent, as the user does from its composer; once per client id. */
export async function sendTaskMessage(id: string, raw: SendMessageInput): Promise<Task> {
  refusePromptAsUser()
  const input = sendMessageInput.parse(raw)
  return sendOnce(sendKey('task_message', id, input.client_id), async () => deliverMessage(id, input), {
    save: () => null,
    load: async () => requireTask(id),
  })
}

async function deliverMessage(id: string, input: z.output<typeof sendMessageInput>): Promise<Task> {
  const refusal = slashRefusal(input.prompt)
  if (refusal !== null) {
    throw new HttpError(400, refusal)
  }
  refuseCommandAttachments(input.prompt, input.attachments)
  const { prompt, attachments } = await placeAttachments(id, input.prompt, input.attachments)
  const wait = input.notify_when_done ? await awaitTurnEnd(await requireTask(id)) : null
  try {
    const outcome = await runTurn(id, prompt, {
      interrupt: input.interrupt,
      attachments,
      ...(input.client_id === undefined ? {} : { clientId: input.client_id }),
    })
    await auditMessage(await requireTask(id), prompt, outcome)
  } catch (e) {
    if (wait !== null) {
      await dropWait(wait)
    }
    throw e
  }
  return requireTask(id)
}

/**
 * Sends the task's stored last message again, as after a turn that failed. It takes no text, so
 * the EA and agents may ask for it: no new words go out in anyone's name.
 */
export async function retryTask(id: string): Promise<Task> {
  refuseOtherAgent(id)
  const { prompt, outcome } = await retryLastPrompt(id)
  await auditMessage(await requireTask(id), prompt, outcome, { retry: true })
  return requireTask(id)
}

/** Takes back a message queued for the running turn before the agent reads it. */
export async function takeBackQueued(task: Task, messageId: number): Promise<Task> {
  const row = await messages.get(task.id, messageId)
  if (row?.kind !== 'prompt') {
    throw new HttpError(404, 'Message not found')
  }
  await removeQueued(task.id, messageId)
  await auditTask('task.queued_message_removed', task, { prompt: row.payload.text })
  return requireTask(task.id)
}

/** Ends the task's session with the subagents and commands still running after its turn. */
export async function endTaskSession(id: string): Promise<Task> {
  if (!sessionState(id).open) {
    throw new HttpError(409, 'The agent has no open session')
  }
  await endSession(id)
  await auditTask('task.session_ended', await requireTask(id))
  return requireTask(id)
}

export async function requireSubtask(taskId: string, toolUseId: string): Promise<Subtask> {
  const subtask = await subtaskOf((await requireTask(taskId)).id, toolUseId, openQuerySince(taskId))
  if (!subtask) {
    throw new HttpError(404, 'Subtask not found')
  }
  return subtask
}

/** Links a PR to one subagent of the task, and to the task itself. */
export async function linkSubtaskPrUrl(taskId: string, toolUseId: string, url: string): Promise<Subtask> {
  const subtask = await requireSubtask(taskId, toolUseId)
  await linkTaskPr(taskId, url)
  await linkSubtaskPr(taskId, url, subtask, 'user')
  await publishSubtasks(taskId, openQuerySince(taskId))
  return requireSubtask(taskId, toolUseId)
}

/** Unlinks a PR from one subagent of the task; the task keeps its own link. */
export async function unlinkSubtaskPrUrl(taskId: string, toolUseId: string, url: string): Promise<Subtask> {
  const subtask = await requireSubtask(taskId, toolUseId)
  if (!(await unlinkSubtaskPr(taskId, url, subtask))) {
    throw new HttpError(404, 'That pull request is not linked to this subagent')
  }
  await publishSubtasks(taskId, openQuerySince(taskId))
  return requireSubtask(taskId, toolUseId)
}

/** Stops one running subagent of the task. */
export async function stopSubtask(id: string, toolUseId: string): Promise<Subtask> {
  const subtask = await requireSubtask(id, toolUseId)
  if (subtask.status !== 'running' || subtask.sdk_task_id === null) {
    throw new HttpError(409, 'That subagent is not running')
  }
  if (!(await stopSessionTask(id, subtask.sdk_task_id))) {
    throw new HttpError(409, 'The session that ran this subagent has ended')
  }
  await auditTask('task.subtask_stopped', await requireTask(id), { subtask: subtask.description })
  return requireSubtask(id, toolUseId)
}

/** Deletes the task with its transcript, worktrees and session. */
export async function deleteTask(task: Task): Promise<void> {
  await endSession(task.id)
  endAgentTerminals(task.id, 'deleted')
  closeAgentChats(task.id)
  await removeTaskFiles(task)
  await tasks.remove(task.id)
  forgetSubtasks(task.id)
  await auditTask('task.deleted', task)
}
