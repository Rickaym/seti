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
import { withinDelegateLimits } from './crew/delegate-limits.js'
import { withBrief } from './crew/handover.js'
import { roleStart, withRole } from './crew/role-start.js'
import { fromEa } from './ea-guard.js'
import { planAgent, planTitle } from './planner.js'
import type { AgentWait } from './store/agent-waits.js'
import { approvalCeilings } from './store/approval-ceilings.js'
import { requireTask, startTask } from './tasks.js'
import { checkStaged, refuseCommandAttachments } from './uploads.js'

/** With notify, sets up the wait once the agent exists and before its first turn starts. */
async function firstTurnWait(notify: boolean, hold: ((wait: AgentWait) => void) | undefined) {
  if (!notify) {
    return undefined
  }
  const waiter = await requestWaiter()
  return async (taskId: string) => {
    const wait = await awaitTurnEnd(await requireTask(taskId), waiter)
    hold?.(wait)
  }
}

/** Holds the new agent to its starter's approvals, then sets up the wait, before its first turn. */
async function beforeFirstTurn(notify: boolean, cap: AccessCap | undefined, hold?: (wait: AgentWait) => void) {
  const waited = await firstTurnWait(notify, hold)
  const ceiling = cap?.approvals ?? null
  return async (taskId: string) => {
    if (ceiling !== null) {
      await approvalCeilings.set(taskId, ceiling)
    }
    await waited?.(taskId)
  }
}

/**
 * Plans what the caller did not pin, then starts the agent on the default profile, sandboxed
 * unless the user turned that off. An agent starting another passes its cap: the new one is
 * sandboxed, gets nothing its starter lacks, grants nothing and settles no call more loosely.
 */
export async function startAgent(
  input: StartAgentRequest,
  cap?: AccessCap,
  hold?: (wait: AgentWait) => void,
): Promise<Task> {
  const start = async () =>
    sendOnce(
      sendKey('task_start', 'new', input.client_id),
      async () => startPlanned(cap === undefined ? input : { ...input, sandbox: true }, cap, hold),
      {
        save: (task) => task.id,
        load: requireTask,
      },
    )
  return cap === undefined ? start() : withinDelegateLimits(cap.task_id, start)
}

/** The fields a start names only when its caller set them. */
const optionalFields = (input: StartAgentRequest, cap: AccessCap | undefined, model: string | undefined) => ({
  ...(input.pr_urls === undefined ? {} : { pr_urls: input.pr_urls }),
  ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
  ...(model === undefined ? {} : { model }),
  ...(input.effort === undefined ? {} : { effort: input.effort }),
  ...(cap === undefined ? {} : { delegated_by: cap.task_id }),
})

/** The first message: the prompt, and after it a brief of the agent it names, if it names one. */
async function firstPrompt(input: StartAgentRequest): Promise<string> {
  return input.brief_of === undefined ? input.prompt : withBrief(input.prompt, await requireTask(input.brief_of))
}

async function startPlanned(
  input: StartAgentRequest,
  cap?: AccessCap,
  hold?: (wait: AgentWait) => void,
): Promise<Task> {
  refuseCommandAttachments(input.prompt, input.attachments)
  checkStaged(input.attachments)
  const onCreated = await beforeFirstTurn(input.notify_when_done, cap, hold)
  const plan = await planAgent(input.prompt, {
    title: input.title,
    fromEa: fromEa(),
    fromAgent: cap !== undefined,
  })
  const capped = cap === undefined ? null : await capStart(cap)
  const mcpOff = new Set([...plan.mcp_disabled, ...(capped?.mcp_disabled ?? [])])
  const profileId = cap?.profile_id ?? DEFAULT_PROFILE_ID
  const roled = await roleStart(input, profileId)
  const held = [...plan.setup.withheld, ...(capped?.held ?? []), ...roled.held]
  return startTask(
    {
      title: plan.title,
      prompt: await firstPrompt(input),
      context_pack_ids: await withRole(plan.context_pack_ids, roled.role),
      disabled_plugin_ids: capped?.disabled_plugin_ids ?? [],
      mcp_enabled: plan.mcp_enabled.filter((name) => cap === undefined || cap.mcp.has(name)),
      mcp_disabled: [...mcpOff],
      sandbox: input.sandbox,
      access: [...plan.access, ...(capped?.access ?? [])],
      profile_id: profileId,
      seti_control: DEFAULT_SETI_CONTROL,
      setup: { ...plan.setup, withheld: held },
      attachments: input.attachments,
      runtime: roled.runtime,
      ...optionalFields(input, cap, roled.model),
    },
    onCreated,
  )
}

/** An explicit create request; a missing title comes from the planner. */
export async function createTask(input: CreateTaskRequest): Promise<Task> {
  return startTask({ ...input, title: input.title ?? (await planTitle(input.prompt)) })
}
