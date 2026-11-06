import { workspaceInput, type Workspace } from '@seti/shared'
import { z } from 'zod'
import { workspaceRows } from '../store/workspaces.js'
import { listWorkspaces, updateTask } from '../task-actions.js'
import { createWorkspace, deleteWorkspace, renameWorkspace } from '../workspaces.js'
import { anyTask, pickOne, taskRef } from './refs.js'
import { done, setiTool, ToolRefusal } from './tool.js'

export const workspaceRef = z
  .string()
  .trim()
  .min(1)
  .describe("The workspace's id or its name; a unique part of the name works too.")

/** The workspace a tool argument names. */
export async function resolveWorkspace(ref: string): Promise<Workspace> {
  return pickOne(await workspaceRows.list(), ref, 'workspace', (workspace) => [workspace.id, workspace.name])
}

/** Workspace names by id, for showing where agents are. */
export async function workspaceNames(): Promise<Map<string, string>> {
  return new Map((await workspaceRows.list()).map((workspace) => [workspace.id, workspace.name]))
}

const listWorkspacesTool = setiTool({
  name: 'list_workspaces',
  description:
    'List the workspaces, the named groups agents belong to, in order, with how many agents each holds and how many of those need the user. The first takes agents started without a workspace.',
  input: {},
  run: async () => listWorkspaces(),
})

const CHANGES = ['create', 'rename', 'delete'] as const

function required(value: string | undefined, refusal: string): string {
  if (value === undefined) {
    throw new ToolRefusal(refusal)
  }
  return value
}

/** One tool for the three changes, as the EA has it, which keeps both catalogs small. */
const changeWorkspaceTool = setiTool({
  name: 'change_workspace',
  description:
    'Create, rename or delete a workspace: a named group of agents with its own pinned and other agents. Names are unique whatever their case. Seti refuses to delete a workspace that holds agents, archived ones included, and keeps the last one.',
  input: {
    action: z.enum(CHANGES),
    workspace: workspaceRef.optional().describe('With rename or delete: the workspace, by id or name.'),
    name: workspaceInput.shape.name.optional().describe('With create or rename: the new name.'),
  },
  run: async ({ action, workspace: ref, name }) => {
    if (action === 'create') {
      return createWorkspace(required(name, 'Give the new workspace a name.'))
    }
    const workspace = await resolveWorkspace(required(ref, `Name the workspace to ${action}.`))
    if (action === 'rename') {
      return renameWorkspace(workspace.id, required(name, 'Give the workspace its new name.'))
    }
    await deleteWorkspace(workspace.id)
    return done(`Deleted workspace ${workspace.name}.`)
  },
})

const moveAgentTool = setiTool({
  name: 'move_agent_to_workspace',
  description: 'Move an agent, archived or not, to another workspace. It keeps its pin, transcript and work.',
  input: { task: taskRef, workspace: workspaceRef },
  run: async ({ task: ref, workspace: target }) => {
    const [task, workspace] = await Promise.all([anyTask(ref), resolveWorkspace(target)])
    await updateTask(task.id, { workspace_id: workspace.id })
    return done(`Moved ${task.title} to ${workspace.name}.`)
  },
})

export const WORKSPACE_TOOLS = [listWorkspacesTool, changeWorkspaceTool, moveAgentTool]
