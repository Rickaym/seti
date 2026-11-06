import { z } from 'zod'
import { lenientArray, orDefault, type ResponseSchema } from './lenient.js'

export const WORKSPACE_NAME_MAX = 60

/** A workspace by id, as start, import and move requests name one. */
export const workspaceId = z.string().trim().min(1).max(64)

const workspaceName = z
  .string()
  .trim()
  .min(1, 'Name the workspace')
  .max(WORKSPACE_NAME_MAX, `keep the name to ${String(WORKSPACE_NAME_MAX)} characters`)

export const workspaceInput = z.object({ name: workspaceName })

/** A named group of agents; every agent belongs to exactly one. */
export interface Workspace {
  id: string
  name: string
  /** Lists go by it; the first workspace takes agents started without one. */
  position: number
  created_at: string
}

export interface WorkspaceEntry extends Workspace {
  /** Agents that are not archived. */
  agents: number
  /** Of those, the ones that need the user. */
  needs_you: number
}

const count = (label: string) => orDefault(label, z.number().int().min(0), 0)

const workspaceEntrySchema = z.object({
  id: z.string(),
  name: orDefault('workspace name', z.string(), 'Workspace'),
  position: count('workspace position'),
  created_at: z.string(),
  agents: count('workspace agents'),
  needs_you: count('workspace needs_you'),
}) satisfies ResponseSchema<WorkspaceEntry>

export const workspaceListSchema = lenientArray('workspace', workspaceEntrySchema) satisfies ResponseSchema<
  WorkspaceEntry[]
>
