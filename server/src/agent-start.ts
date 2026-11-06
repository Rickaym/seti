import {
  DEFAULT_PROFILE_ID,
  DEFAULT_SETI_CONTROL,
  type CreateTaskRequest,
  type StartAgentRequest,
  type Task,
} from '@seti/shared'
import { capStart, type AccessCap } from './agent-cap.js'
import { awaitTurnEnd, requestWaiter } from './agent-waits.js'
import { sendKey, sendOnce } from './client-sends.js'
import { fromEa } from './ea-guard.js'
import { planAgent, planTitle } from './planner.js'
import { requireTask, startTask } from './tasks.js'
import { checkStaged, refuseCommandAttachments } from './uploads.js'

/** With notify, sets up the wait once the agent exists and before its first turn starts. */
async function firstTurnWait(notify: boolean) {
  if (!notify) {
    return undefined
  }
  const waiter = await requestWaiter()
  return async (taskId: string) => {
    await awaitTurnEnd(await requireTask(taskId), waiter)
  }
}

/**
 * Plans what the caller did not pin, then starts the agent sandboxed on the default profile. An
 * agent starting another passes its cap: the new one gets nothing it lacks and grants nothing.
 */
export async function startAgent(input: StartAgentRequest, cap?: AccessCap): Promise<Task> {
  return sendOnce(sendKey('task_start', 'new', input.client_id), async () => startPlanned(input, cap), {
    save: (task) => task.id,
    load: requireTask,
  })
}

async function startPlanned(input: StartAgentRequest, cap?: AccessCap): Promise<Task> {
  refuseCommandAttachments(input.prompt, input.attachments)
  checkStaged(input.attachments)
  const onCreated = await firstTurnWait(input.notify_when_done)
  const plan = await planAgent(input.prompt, {
    title: input.title,
    repo_ids: input.repo_ids,
    worktree: input.worktree,
    cwd: input.cwd,
    fromEa: fromEa(),
    fromAgent: cap !== undefined,
  })
  const capped = cap === undefined ? null : await capStart(cap)
  const mcpOff = new Set([...plan.mcp_disabled, ...(capped?.mcp_disabled ?? [])])
  return startTask(
    {
      title: plan.title,
      prompt: input.prompt,
      repo_ids: plan.repo_ids,
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      worktree: plan.worktree,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.pr_urls === undefined ? {} : { pr_urls: input.pr_urls }),
      context_pack_ids: plan.context_pack_ids,
      disabled_plugin_ids: capped?.disabled_plugin_ids ?? [],
      mcp_enabled: plan.mcp_enabled.filter((name) => cap === undefined || cap.mcp.has(name)),
      mcp_disabled: [...mcpOff],
      sandbox: true,
      access: [...plan.access, ...(capped?.access ?? [])],
      profile_id: cap?.profile_id ?? DEFAULT_PROFILE_ID,
      seti_control: DEFAULT_SETI_CONTROL,
      setup: capped === null ? plan.setup : { ...plan.setup, withheld: [...plan.setup.withheld, ...capped.held] },
      attachments: input.attachments,
      ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
    },
    onCreated,
  )
}

/** An explicit create request; a missing title comes from the planner. */
export async function createTask(input: CreateTaskRequest): Promise<Task> {
  return startTask({ ...input, title: input.title ?? (await planTitle(input.prompt)) })
}
