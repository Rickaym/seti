import type { GridLayout, Workspace, WorkspaceGrid } from '@seti/shared'
import { sql } from '../db.js'

const COLUMNS = sql`id, name, position, created_at`

export const workspaceRows = {
  /** Every workspace in list order; the first takes agents started without one. */
  list: async (): Promise<Workspace[]> =>
    sql<Workspace[]>`SELECT ${COLUMNS} FROM workspace ORDER BY position, created_at, id`,
  get: async (id: string): Promise<Workspace | undefined> =>
    (await sql<Workspace[]>`SELECT ${COLUMNS} FROM workspace WHERE id = ${id}`).at(0),
  /** Adds a workspace after the others; a name taken in any case fails as a unique violation. */
  insert: async (row: Pick<Workspace, 'id' | 'name' | 'created_at'>): Promise<void> => {
    await sql`INSERT INTO workspace (id, name, position, created_at)
      VALUES (${row.id}, ${row.name}, (SELECT COALESCE(MAX(position) + 1, 0) FROM workspace), ${row.created_at})`
  },
  rename: async (id: string, name: string): Promise<void> => {
    await sql`UPDATE workspace SET name = ${name} WHERE id = ${id}`
  },
  remove: async (id: string): Promise<void> => {
    await sql`DELETE FROM workspace WHERE id = ${id}`
  },
  /** Agents in the workspace, archived ones included. */
  agentCount: async (id: string): Promise<number> => {
    const [row] = await sql<{ count: number }[]>`SELECT COUNT(*)::int AS count FROM task WHERE workspace_id = ${id}`
    return row?.count ?? 0
  },
}

const GRID_COLUMNS = sql`workspace_id, layout, revision, updated_at`

export const workspaceGridRows = {
  list: async (): Promise<WorkspaceGrid[]> =>
    sql<WorkspaceGrid[]>`SELECT ${GRID_COLUMNS} FROM workspace_grid ORDER BY workspace_id`,
  get: async (workspaceId: string): Promise<WorkspaceGrid | undefined> => {
    const [row] = await sql<WorkspaceGrid[]>`SELECT ${GRID_COLUMNS} FROM workspace_grid
      WHERE workspace_id = ${workspaceId}`
    return row
  },
  /** Stores the layout over any other, one revision on; returns it as stored. */
  put: async (workspaceId: string, layout: GridLayout, at: string): Promise<WorkspaceGrid> => {
    const json = sql.json({
      panels: layout.panels.map((panel) => ({ ...panel })),
      locked: layout.locked,
      perScreen: layout.perScreen,
    })
    const [row] = await sql<WorkspaceGrid[]>`INSERT INTO workspace_grid (workspace_id, layout, revision, updated_at)
      VALUES (${workspaceId}, ${json}, 1, ${at})
      ON CONFLICT (workspace_id) DO UPDATE
        SET layout = EXCLUDED.layout, revision = workspace_grid.revision + 1, updated_at = EXCLUDED.updated_at
      RETURNING ${GRID_COLUMNS}`
    if (row === undefined) {
      throw new Error('the grid was not stored')
    }
    return row
  },
}
