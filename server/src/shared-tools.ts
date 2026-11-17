import type { SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  missingNeeds,
  type AuditKind,
  type ChangeRequest,
  type SharedTool,
  type SharedToolChange,
  type SharedToolCode,
  type Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { sandboxed } from './aws-access.js'
import { fromEa, refuseAgent, refuseAtSelf, refuseMod } from './ea-guard.js'
import { HttpError } from './http.js'
import {
  removeOtherFolders,
  toolFolder,
  toolFolderReady,
  toolPluginName,
  writeToolFolder,
} from './shared-tool-files.js'
import { connectionRows } from './store/connections.js'
import { sharedTools, withoutCode } from './store/shared-tools.js'

/** What decides whether an agent loads a shared tool. */
interface Agent {
  sandboxed: boolean
  /** The variables of the connections the agent's credential carries. */
  envs: readonly string[]
}

/** Whether an agent gets a tool, and what it lacks when it does not. */
export interface ToolReach {
  available: boolean
  missing: string[]
  why: string | null
}

/**
 * A tool loads only into a sandboxed agent, so the script never runs with the host's access, and
 * only when the agent's credential carries a connection for every variable the script reads.
 */
export function toolReach(tool: Pick<SharedTool, 'enabled' | 'needs'>, agent: Agent): ToolReach {
  const missing = missingNeeds(tool.needs, agent.envs)
  if (!tool.enabled) {
    return { available: false, missing, why: 'The user turned it off.' }
  }
  if (!agent.sandboxed) {
    return { available: false, missing, why: 'Shared tools load only in sandboxed agents.' }
  }
  if (missing.length > 0) {
    const why = `Your credential lacks ${missing.join(', ')}; ask for it with request_change, kind api_key.`
    return { available: false, missing, why }
  }
  return { available: true, missing, why: null }
}

async function agentOf(task: Task): Promise<Agent> {
  return {
    sandboxed: await sandboxed(task),
    envs: (await connectionRows.profileList(task.profile_id)).map((row) => row.env),
  }
}

/** Every published tool with whether the task's agent gets it, for the agent's own listing. */
export async function sharedToolsFor(task: Task): Promise<(SharedTool & ToolReach & { skill: string })[]> {
  const agent = await agentOf(task)
  return (await sharedTools.list()).map((tool) => ({
    ...tool,
    ...toolReach(tool, agent),
    skill: `${toolPluginName(tool.name)}:${tool.name}`,
  }))
}

/** The plugin folders of the shared tools a task's next session loads. */
export async function sharedToolPlugins(task: Task): Promise<SdkPluginConfig[]> {
  const tools = await sharedTools.list()
  if (tools.length === 0) {
    return []
  }
  const agent = await agentOf(task)
  return tools
    .filter((tool) => toolReach(tool, agent).available && toolFolderReady(tool))
    .map((tool) => ({ type: 'local', path: toolFolder(tool) }))
}

type ToolAuditKind = Extract<AuditKind, `shared_tool.${string}`>

interface ToolEvent {
  kind: ToolAuditKind
  tool: Pick<SharedTool, 'name' | 'sha256'>
  summary: string
  taskId: string | null
  requestId?: string
}

/** Records a step of a tool's life by its name, hash and agent; never its code. */
export async function auditTool({ kind, tool, summary, taskId, requestId }: ToolEvent): Promise<void> {
  await audit.record({
    actor: 'user',
    kind,
    subject_type: 'shared_tool',
    subject_id: tool.name,
    summary,
    detail: {
      name: tool.name,
      sha256: tool.sha256,
      task_id: taskId,
      ...(requestId === undefined ? {} : { request_id: requestId }),
    },
  })
}

const MOVED = 'The published tool changed after the agent asked; deny this and have the agent propose it again.'

/** Publishes an allowed proposal: the reviewed snapshot becomes the tool and its plugin folder. */
export async function publishSharedTool(task: Task, request: ChangeRequest, change: SharedToolChange): Promise<void> {
  refuseAgent('publish shared tools')
  const before = await sharedTools.get(change.name)
  const live = before?.sha256 ?? null
  if (live !== (change.snapshot.replaces?.sha256 ?? null) && live !== change.snapshot.sha256) {
    throw new HttpError(409, MOVED)
  }
  const tool = {
    name: change.name,
    description: change.description,
    file: change.snapshot.file,
    content: change.snapshot.content,
    sha256: change.snapshot.sha256,
    needs: change.needs,
  }
  await writeToolFolder(tool)
  await sharedTools.publish({ ...tool, proposer_task_id: task.id, proposer_title: task.title })
  await removeOtherFolders(await sharedTools.list())
  const verb = before === undefined ? 'Published' : 'Updated'
  await auditTool({
    kind: 'shared_tool.allowed',
    tool,
    summary: `${verb} the shared tool ${tool.name} that task "${task.title}" proposed`,
    taskId: task.id,
    requestId: request.id,
  })
}

async function requireTool(name: string): Promise<SharedToolCode> {
  const tool = await sharedTools.get(name)
  if (tool === undefined) {
    throw new HttpError(404, `No shared tool is named ${name}`)
  }
  return tool
}

export const listSharedTools = async (): Promise<SharedTool[]> => sharedTools.list()

export const sharedToolCode = requireTool

/**
 * Turns a tool off for every agent, or back on. Off narrows what agents run, so the EA and agents
 * at Seti control Full may do it; on puts approved code back in every agent, which stays the
 * user's.
 */
export async function setSharedToolEnabled(name: string, enabled: boolean): Promise<SharedTool> {
  if (enabled) {
    refuseAgent('turn shared tools on')
  }
  if (enabled && fromEa()) {
    throw new HttpError(403, 'The EA cannot turn shared tools on; the user does that in Seti')
  }
  refuseMod('turn shared tools off')
  refuseAtSelf('turn shared tools off')
  const tool = withoutCode(await requireTool(name))
  if (tool.enabled === enabled) {
    return tool
  }
  await sharedTools.setEnabled(name, enabled)
  await auditTool({
    kind: enabled ? 'shared_tool.enabled' : 'shared_tool.disabled',
    tool,
    summary: `Turned the shared tool ${name} ${enabled ? 'on' : 'off'} for every agent`,
    taskId: tool.proposer_task_id,
  })
  return { ...tool, enabled }
}

/** Removes a tool and its code; only a new proposal and the user's Allow bring it back. */
export async function removeSharedTool(name: string): Promise<void> {
  refuseAgent('remove shared tools')
  const tool = await requireTool(name)
  await sharedTools.remove(name)
  await removeOtherFolders(await sharedTools.list())
  await auditTool({
    kind: 'shared_tool.removed',
    tool,
    summary: `Removed the shared tool ${name}`,
    taskId: tool.proposer_task_id,
  })
}

/** Writes the folders of the published tools again where they are missing or changed. */
export async function syncSharedTools(): Promise<void> {
  const tools = await sharedTools.listCode()
  for (const tool of tools) {
    await writeToolFolder(tool)
  }
  await removeOtherFolders(tools)
}
