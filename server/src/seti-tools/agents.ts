import {
  AGENT_COLOR_PRESETS,
  agentColorFromWords,
  listedStatus,
  restartSessionInput,
  rewindInput,
  sendMessageInput,
  startAgentInput,
  TASK_STATUSES,
  updateTaskInput,
  type Task,
  type TaskListEntry,
} from '@seti/shared'
import { z } from 'zod'
import { capOf } from '../agent-cap.js'
import { startAgent } from '../agent-start.js'
import { archiveTask, listArchived, unarchiveTask } from '../archive.js'
import { repos } from '../db.js'
import { HttpError } from '../http.js'
import { deliverPending, dismissPending } from '../inputs.js'
import { rewindTargets, rewindTask } from '../rewind-task.js'
import { openQuerySince } from '../runner.js'
import { restartSession } from '../session-restart.js'
import { subtaskBriefs } from '../subtask-cache.js'
import {
  deleteTask,
  endTaskSession,
  retryTask,
  stopSubtask,
  stopTask,
  switchBackModel,
  takeBackQueued,
  taskListEntries,
  transcriptPage,
  updateTask,
} from '../task-actions.js'
import { anyTask, liveTask, pickOne, taskRef } from './refs.js'
import { done, notSelf, setiTool, ToolRefusal, type ToolContext } from './tool.js'
import { resolveWorkspace, workspaceNames, workspaceRef } from './workspaces.js'

const NOTIFY_WHEN_DONE = sendMessageInput.shape.notify_when_done.describe(
  'Get an update with its final message when that turn ends, instead of polling.',
)
const QUEUE_SCAN = 200
/** Long-lived agents link many PRs; lists show the newest and the count. */
const PRS_SHOWN = 10

/** The fields an agent needs to tell agents apart and act on them. */
export const brief = (task: Task | TaskListEntry) => ({
  id: task.id,
  title: task.title,
  status: 'subtask_counts' in task ? listedStatus(task) : task.status,
  repos: task.repos.map((repo) => repo.slug),
  cwd: task.cwd,
  pr_urls: task.pr_urls.slice(-PRS_SHOWN),
  ...(task.pr_urls.length > PRS_SHOWN ? { pr_count: task.pr_urls.length } : {}),
  pinned: task.pinned,
  updated_at: task.updated_at,
  workspace_id: task.workspace_id,
  ...(task.status_line === null ? {} : { status_line: task.status_line }),
  ...(task.last_error === null ? {} : { last_error: task.last_error }),
  ...(task.archived_at === null ? {} : { archived_at: task.archived_at }),
})

const listTasks = setiTool({
  name: 'list_tasks',
  description:
    'List the agents in Seti, pinned first then most recently changed, with their workspace, status, repos and linked PRs.',
  input: {
    status: z.enum(TASK_STATUSES).optional().describe('Only agents with this status.'),
    workspace: workspaceRef.optional().describe('Only agents in this workspace, by id or name.'),
  },
  run: async ({ status, workspace: ref }) => {
    const [entries, names, only] = await Promise.all([
      taskListEntries(),
      workspaceNames(),
      ref === undefined ? undefined : resolveWorkspace(ref),
    ])
    return entries
      .filter((task) => status === undefined || task.status === status)
      .filter((task) => only === undefined || task.workspace_id === only.id)
      .map((task) => ({ ...brief(task), workspace: names.get(task.workspace_id) ?? null }))
  },
})

const stopTaskTool = setiTool({
  name: 'stop_task',
  description: "Stop another agent's running turn. You cannot stop yourself.",
  input: { task: taskRef },
  run: async ({ task: ref }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'stop')
    return brief(await stopTask(task.id))
  },
})

const handOverUpdates = setiTool({
  name: 'hand_over_updates',
  description: 'Hand the updates waiting for an agent (PR CI, reviews, comments) to it now, which starts a turn.',
  input: { task: taskRef },
  run: async ({ task: ref }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'hand updates to')
    return done(`Handed ${String(await deliverPending(task.id, 'user'))} updates to ${task.title}.`)
  },
})

/** A directory the caller works in, or one inside it; agents start others only where they work. */
function ownDirectory(ctx: ToolContext, dir: string): string {
  const mine = [ctx.caller.cwd, ...ctx.caller.repos.map((repo) => repo.dir), ...ctx.caller.dirs]
  const inside = mine.some((root) => dir === root || dir.startsWith(root.endsWith('/') ? root : `${root}/`))
  if (!inside) {
    throw new ToolRefusal(
      `You can start agents only in a registered repo or in a directory of your own: ${mine.join(', ')}`,
    )
  }
  return dir
}

const startTaskTool = setiTool({
  name: 'start_task',
  description:
    "Start a new agent on a prompt. Seti's planner titles it and picks repos, context packs and MCP servers for what you leave out. It runs sandboxed with at most your own access: never SSH, AWS, MCP servers, plugins or credentials you lack, and Seti control Self, never Full. With notify_when_done, Seti sends you its final message as an update once its first turn ends.",
  input: {
    prompt: startAgentInput.shape.prompt,
    title: startAgentInput.shape.title,
    repos: z.array(z.string().trim().min(1)).max(10).optional().describe('Registered repos by slug or id.'),
    worktree: startAgentInput.shape.worktree,
    directory: z.string().trim().min(1).optional().describe('An existing directory of yours, instead of repos.'),
    workspace: workspaceRef.optional().describe('The workspace it joins; left out, your own.'),
    notify_when_done: NOTIFY_WHEN_DONE,
  },
  run: async ({ prompt, title, repos: refs, worktree, directory, workspace, notify_when_done }, ctx) => {
    const registered = await repos.list()
    const repoIds = refs?.map((ref) => pickOne(registered, ref, 'repo', (repo) => [repo.id, repo.slug]).id)
    const input = startAgentInput.parse({
      prompt,
      title,
      ...(repoIds === undefined || repoIds.length === 0 ? {} : { repo_ids: [...new Set(repoIds)], worktree }),
      ...(directory === undefined || repoIds !== undefined ? {} : { cwd: ownDirectory(ctx, directory) }),
      workspace_id: workspace === undefined ? ctx.caller.workspace_id : (await resolveWorkspace(workspace)).id,
      notify_when_done,
    })
    const task = await startAgent(input, await capOf(ctx.caller))
    return { ...brief(task), setup: task.setup }
  },
})

const renameAgent = setiTool({
  name: 'rename_agent',
  description: 'Give an agent a new title. Its group chat handle stays as it is.',
  input: { task: taskRef, title: updateTaskInput.shape.title.unwrap() },
  run: async ({ task: ref, title }) => brief(await updateTask((await liveTask(ref)).id, { title })),
})

const pinAgent = setiTool({
  name: 'pin_agent',
  description: 'Pin or unpin an agent. A pinned agent is listed first and never archived or cleaned up on its own.',
  input: { task: taskRef, pinned: updateTaskInput.shape.pinned.unwrap() },
  run: async ({ task: ref, pinned }) => brief(await updateTask((await liveTask(ref)).id, { pinned })),
})

const setAgentColor = setiTool({
  name: 'set_agent_color',
  description:
    'Mark an agent with a colour the user recognises it by: a stripe on its row, a tint behind its header, its panel frame and its reply box. Seti adapts the colour to each theme and gives each new agent a preset the other agents use least. null clears it.',
  input: {
    task: taskRef,
    color: z
      .string()
      .nullable()
      .describe(
        `A hex such as #3b82f6 or #38f, or a preset: ${AGENT_COLOR_PRESETS.map((preset) => preset.name).join(', ')}. Everyday names such as purple or navy pick the nearest preset.`,
      ),
  },
  run: async ({ task: ref, color }) => {
    const hex = color === null ? null : agentColorFromWords(color)
    if (color !== null && hex === null) {
      throw new HttpError(400, `${color} is not a colour Seti knows; send a hex such as #3b82f6 or a preset name.`)
    }
    return brief(await updateTask((await liveTask(ref)).id, { color: hex }))
  },
})

const setUpdateMode = setiTool({
  name: 'set_update_mode',
  description:
    'Choose what an agent does with updates on its linked PRs and channels: wake starts a turn, queue holds them for the next message, off ignores them.',
  input: { task: taskRef, mode: updateTaskInput.shape.input_mode.unwrap() },
  run: async ({ task: ref, mode }) => brief(await updateTask((await liveTask(ref)).id, { input_mode: mode })),
})

const deleteAgent = setiTool({
  name: 'delete_agent',
  description:
    'Permanently delete another agent, archived or not: its transcript, worktrees, scratch folder, workspace, archive bundle and session.',
  input: { task: taskRef },
  run: async ({ task: ref }, ctx) => {
    const task = await anyTask(ref)
    notSelf(ctx, task, 'delete')
    await deleteTask(task)
    return done(`Deleted ${task.title}.`)
  },
})

const archiveAgent = setiTool({
  name: 'archive_agent',
  description:
    'Archive another agent: it leaves the agent list and takes no work. Its scratch folder and workspace are packed into a bundle, and its worktree is removed when clean unless keep_worktree. restore_agent brings it all back.',
  input: { task: taskRef, keep_worktree: z.boolean().default(false) },
  run: async ({ task: ref, keep_worktree: keep }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'archive')
    return archiveTask(task.id, { actor: 'user', removeWorktree: !keep })
  },
})

const restoreAgent = setiTool({
  name: 'restore_agent',
  description: 'Bring an archived agent back to the agent list with its transcript and worktree.',
  input: { task: taskRef },
  run: async ({ task: ref }) => unarchiveTask((await anyTask(ref)).id),
})

const listArchivedAgents = setiTool({
  name: 'list_archived_agents',
  description: 'List archived agents, newest first, with what their archives saved.',
  input: {},
  run: async () => listArchived(),
})

const rewindAgent = setiTool({
  name: 'rewind_agent',
  description:
    'Take another, idle agent back to just before one of its earlier prompts: its conversation, the files it edited since, or both. Name the prompt by its message id or its text.',
  input: {
    task: taskRef,
    prompt: z.string().trim().min(1).describe('The message id of the prompt, or words from it.'),
    restore: rewindInput.shape.restore,
  },
  run: async ({ task: ref, prompt, restore }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'rewind')
    const target = pickOne(await rewindTargets(task.id), prompt, 'prompt', (t) => [String(t.message_id), t.text])
    return rewindTask(task.id, target.message_id, restore)
  },
})

const takeBackMessage = setiTool({
  name: 'take_back_message',
  description:
    'Take back a message queued for a running agent before it reads it: the one whose text you give, else the latest.',
  input: { task: taskRef, message: z.string().trim().min(1).optional() },
  run: async ({ task: ref, message }) => {
    const task = await liveTask(ref)
    const queued = (await transcriptPage(task.id, QUEUE_SCAN)).messages.flatMap((row) =>
      row.kind === 'prompt' && row.payload.queued === 'waiting' ? [row] : [],
    )
    const row =
      message === undefined
        ? queued.at(-1)
        : pickOne(queued, message, 'queued message', (r) => [String(r.id), r.payload.text])
    if (row === undefined) {
      throw new ToolRefusal(`No message is waiting in ${task.title}'s queue.`)
    }
    return brief(await takeBackQueued(task, row.id))
  },
})

const dismissUpdates = setiTool({
  name: 'dismiss_updates',
  description:
    'Dismiss the updates waiting for an agent (PR CI, reviews, comments, group chat, channel events) instead of handing them over.',
  input: { task: taskRef },
  run: async ({ task: ref }) => {
    const task = await liveTask(ref)
    const newest = (await transcriptPage(task.id, 1)).messages.at(-1)?.id ?? 0
    return dismissPending(task.id, newest, 'user')
  },
})

const stopBackgroundWork = setiTool({
  name: 'stop_background_work',
  description: "End another agent's background work: the subagents and commands still running after its turn.",
  input: { task: taskRef },
  run: async ({ task: ref }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'end the background work of')
    return brief(await endTaskSession(task.id))
  },
})

const restartAgentSession = setiTool({
  name: 'restart_agent_session',
  description:
    "Restart another agent's Claude Code session, as when its MCP servers failed or it seems stuck: the conversation is kept and its background work ends; a running turn stops first. With fresh it forgets the conversation instead.",
  input: { task: taskRef, fresh: restartSessionInput.shape.fresh },
  run: async ({ task: ref, fresh }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, 'restart')
    await restartSession(task, { interrupt: true, fresh })
    return done(`Restarted the session of ${task.title}${fresh ? ' fresh' : ''}.`)
  },
})

const retryAgentTurn = setiTool({
  name: 'retry_agent_turn',
  description:
    "Send another agent's last message again, unchanged, as after a turn that failed or that a Seti restart cut off. With switch_back_model, send /model with the model Claude Code switched away from after a safeguard refused a request, like the agent's Switch back button; it waits until the turn ends.",
  input: {
    task: taskRef,
    switch_back_model: z
      .boolean()
      .optional()
      .describe('true to move the agent off its fallback model instead of retrying'),
  },
  run: async ({ task: ref, switch_back_model: back }, ctx) => {
    const task = await liveTask(ref)
    notSelf(ctx, task, back === true ? 'switch back the model of' : 'retry the turn of')
    return brief(await (back === true ? switchBackModel(task.id) : retryTask(task.id)))
  },
})

const stopSubagent = setiTool({
  name: 'stop_subagent',
  description: 'Stop one running subagent of an agent, named by its tool use id or its description.',
  input: { task: taskRef, subagent: z.string().trim().min(1) },
  run: async ({ task: ref, subagent }) => {
    const task = await liveTask(ref)
    const running = (await subtaskBriefs(task.id, openQuerySince(task.id))).filter((s) => s.status === 'running')
    const target = pickOne(running, subagent, 'running subagent', (s) => [s.tool_use_id, s.description])
    return stopSubtask(task.id, target.tool_use_id)
  },
})

export const AGENT_TOOLS = [
  listTasks,
  stopTaskTool,
  handOverUpdates,
  startTaskTool,
  renameAgent,
  pinAgent,
  setAgentColor,
  setUpdateMode,
  deleteAgent,
  archiveAgent,
  restoreAgent,
  listArchivedAgents,
  rewindAgent,
  takeBackMessage,
  dismissUpdates,
  stopBackgroundWork,
  restartAgentSession,
  retryAgentTurn,
  stopSubagent,
]
