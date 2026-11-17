import { fileURLToPath } from 'node:url'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  missingNeeds,
  proposedDefinition,
  SHARED_TOOL_SERVER,
  sharedToolCallName,
  type AuditKind,
  type CarriedConnection,
  type ChangeRequest,
  type SharedTool,
  type SharedToolChange,
  type SharedToolCode,
  type Task,
} from '@seti/shared'
import { audit } from './audit.js'
import { fromEa, refuseAgent } from './ea-guard.js'
import { HttpError } from './http.js'
import { removeOtherFolders, toolFolder, toolFolderReady, writeToolFolder } from './shared-tool-files.js'
import { declareToolWrites } from './shared-tool-writes.js'
import { connectionRows } from './store/connections.js'
import { sharedTools, withoutCode } from './store/shared-tools.js'

/** Whether an agent gets a tool, and what it lacks when it does not. */
export interface ToolReach {
  available: boolean
  missing: string[]
  why: string | null
}

/**
 * A tool loads when it is on and the agent's credential carries a connection for every variable
 * the script reads, on the hosts the tool names. Publishing a tool gives no agent a key or host.
 */
export function toolReach(
  tool: Pick<SharedTool, 'enabled' | 'needs'>,
  carried: readonly CarriedConnection[],
): ToolReach {
  const missing = missingNeeds(tool.needs, carried)
  if (!tool.enabled) {
    return { available: false, missing, why: 'The user turned it off.' }
  }
  if (missing.length > 0) {
    const why = `Your credential lacks ${missing.join(', ')} for its hosts; ask with request_change, kind api_key.`
    return { available: false, missing, why }
  }
  return { available: true, missing, why: null }
}

const carriedBy = async (task: Task): Promise<CarriedConnection[]> => connectionRows.profileList(task.profile_id)

/** Every published tool with whether the task's agent gets it, for the agent's own listing. */
export async function sharedToolsFor(task: Task): Promise<(SharedTool & ToolReach & { tool: string })[]> {
  const carried = await carriedBy(task)
  return (await sharedTools.list()).map((tool) => ({
    ...tool,
    ...toolReach(tool, carried),
    tool: sharedToolCallName(tool.name),
  }))
}

/** The folders of the shared tools a task's next session loads. */
export async function sharedToolFolders(task: Task): Promise<string[]> {
  const tools = await sharedTools.list()
  if (tools.length === 0) {
    return []
  }
  const carried = await carriedBy(task)
  return tools.filter((tool) => toolReach(tool, carried).available && toolFolderReady(tool)).map(toolFolder)
}

/** The tool server's own file; Node runs it as it is, and a sandbox mounts it read-only. */
export const TOOL_SERVER = fileURLToPath(new URL('./shared-tool-server.ts', import.meta.url))

/**
 * The MCP server that offers the folders' tools. Claude Code starts it as a child of the agent's
 * own process, so in a sandboxed agent it and the scripts it runs are inside that sandbox.
 */
export const sharedToolServer = (folders: readonly string[]): Record<string, McpServerConfig> =>
  folders.length === 0
    ? {}
    : { [SHARED_TOOL_SERVER]: { type: 'stdio', command: process.execPath, args: [TOOL_SERVER, ...folders] } }

async function noteWrites(): Promise<void> {
  const tools = await sharedTools.list()
  declareToolWrites(new Map(tools.map((tool) => [sharedToolCallName(tool.name), tool.writes])))
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

/** Publishes an allowed proposal: the reviewed snapshot becomes the tool and its folder. */
export async function publishSharedTool(task: Task, request: ChangeRequest, change: SharedToolChange): Promise<void> {
  refuseAgent('publish shared tools')
  const before = await sharedTools.get(change.name)
  const live = before?.sha256 ?? null
  if (live !== (change.snapshot.replaces?.sha256 ?? null) && live !== change.snapshot.sha256) {
    throw new HttpError(409, MOVED)
  }
  const tool = {
    ...proposedDefinition(change),
    content: change.snapshot.content,
    sha256: change.snapshot.sha256,
  }
  await writeToolFolder(tool)
  await sharedTools.publish({ ...tool, proposer_task_id: task.id, proposer_title: task.title })
  await removeOtherFolders(await sharedTools.list())
  await noteWrites()
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
 * Turns a tool off for every agent, or back on. Agents and mods do neither. Off narrows what
 * agents run, so the EA may do it; on puts approved code back in every agent, which stays the
 * user's.
 */
export async function setSharedToolEnabled(name: string, enabled: boolean): Promise<SharedTool> {
  refuseAgent('turn shared tools on or off')
  if (enabled && fromEa()) {
    throw new HttpError(403, 'The EA cannot turn shared tools on; the user does that in Seti')
  }
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
  await noteWrites()
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
  await noteWrites()
}
