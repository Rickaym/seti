import type { GridLayout, WorkspaceGrid } from '@seti/shared'
import { now } from './db.js'
import { HttpError } from './http.js'
import { workspaceGridRows } from './store/workspaces.js'
import { requireWorkspace } from './workspaces.js'

const terminalIds = (layout: GridLayout | undefined) =>
  new Set(layout?.panels.flatMap((panel) => (panel.terminal === undefined ? [] : [panel.terminal.id])) ?? [])

/** Terminals are the user's own shells, so the EA and agents may not put a new one in a layout. */
async function refuseNewTerminals(id: string, layout: GridLayout, delegate: boolean): Promise<void> {
  if (!delegate) {
    return
  }
  const known = terminalIds((await workspaceGridRows.get(id))?.layout)
  if ([...terminalIds(layout)].some((terminal) => !known.has(terminal))) {
    throw new HttpError(403, 'Only the user opens terminals; the EA and agents cannot add one to the grid')
  }
}

/** Stores a workspace's panel layout for every device; the latest save wins. */
export async function saveWorkspaceGrid(id: string, layout: GridLayout, delegate: boolean): Promise<WorkspaceGrid> {
  await requireWorkspace(id)
  await refuseNewTerminals(id, layout, delegate)
  return workspaceGridRows.put(id, layout, now())
}
