import { z } from 'zod'
import { lenientArray, type ResponseSchema } from './lenient.js'
import { terminalRef } from './terminals.js'

/** Columns across the agent grid; 12 splits evenly into one to four and six panels across. */
export const GRID_COLS = 12

/** Rows a panel may start at or span; far beyond any screen, so only nonsense is refused. */
const GRID_ROWS_MAX = 10_000

const GRID_PANELS_MAX = 64

/** The most panels a grid template fills one screen with. */
const GRID_PER_SCREEN_MAX = 6

const unit = (min: number, max: number) => z.number().int().min(min).max(max)

/**
 * One panel's place in the grid, in columns and rows: an agent, a terminal, or neither for an
 * empty panel.
 */
const gridPanel = z.object({
  i: z.string().min(1).max(64),
  agent: z.string().min(1).max(128).nullable(),
  terminal: terminalRef.optional(),
  x: unit(0, GRID_COLS - 1),
  y: unit(0, GRID_ROWS_MAX),
  w: unit(1, GRID_COLS),
  h: unit(1, GRID_ROWS_MAX),
})

/** A workspace's grid as every device shows it: where the panels sit, and whether they stay put. */
const gridLayout = z.object({
  panels: z.array(gridPanel).max(GRID_PANELS_MAX),
  locked: z.boolean(),
  /** The most panels Tidy puts in one screen, the rest on screens below; null fits all in one. */
  perScreen: unit(1, GRID_PER_SCREEN_MAX).nullable().default(null),
})

export type GridLayout = z.infer<typeof gridLayout>

export const gridLayoutInput = z.object({ layout: gridLayout })

export interface WorkspaceGrid {
  workspace_id: string
  layout: GridLayout
  /** Counts the saves, so a device can tell a newer layout from the one it has. */
  revision: number
  updated_at: string
}

const workspaceGridSchema = z.object({
  workspace_id: z.string(),
  layout: gridLayout,
  revision: z.number().int(),
  updated_at: z.string(),
}) satisfies ResponseSchema<WorkspaceGrid>

export const workspaceGridListSchema = lenientArray('workspace grid', workspaceGridSchema) satisfies ResponseSchema<
  WorkspaceGrid[]
>
