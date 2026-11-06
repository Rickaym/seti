import type { WorkspaceGrid } from '@seti/mod-api'
import type { Panel } from './grid-layout'
import { parsePanels } from './grid-storage'

/** One workspace's grid: panels, lock and template are shared by every device, focus stays here. */
export interface Layout {
  panels: readonly Panel[]
  /** Panels hold their place and size; drag and resize are off. */
  locked: boolean
  /** Panels Tidy fits in one screen, the rest on screens below; null fits every panel in one. */
  perScreen: number | null
  /** The panel that takes keys, find and the palette's agent commands. */
  focused: string | null
  /** Agents by when their panel last took focus, latest first. */
  recent: readonly string[]
}

/** A workspace's grid as this device keeps it between visits. */
export interface CachedLayout extends Layout {
  /** The server's revision of the shared fields; 0 for a grid the server never had from here. */
  revision: number
  /** Shared fields changed on this device since the server last took them. */
  dirty: boolean
}

export const EMPTY_LAYOUT: CachedLayout = {
  panels: [],
  locked: false,
  perScreen: null,
  focused: null,
  recent: [],
  revision: 0,
  dirty: false,
}

/** The server's layout, keeping this device's focus while its panel is still there. */
function fromServer(row: WorkspaceGrid, local: CachedLayout | undefined): CachedLayout {
  const panels = parsePanels(row.layout.panels) ?? []
  const kept = panels.some((panel) => panel.i === local?.focused) ? (local?.focused ?? null) : null
  return {
    panels,
    locked: row.layout.locked,
    perScreen: row.layout.perScreen,
    focused: kept ?? panels[0]?.i ?? null,
    recent: local?.recent ?? [],
    revision: row.revision,
    dirty: false,
  }
}

interface Merged {
  layouts: Record<string, CachedLayout>
  /** Workspaces whose grid on this device changed. */
  changed: Set<string>
}

/**
 * This device's grids once the server's arrive. An unsaved edit here is the latest write and
 * stays; a grid the server never had from here goes up once if the server has none; otherwise
 * the server's copy wins. Workspaces in `busy`, such as one mid-drag, stay as they are for now.
 */
export function mergeServer(
  local: Readonly<Record<string, CachedLayout>>,
  rows: readonly WorkspaceGrid[],
  busy: ReadonlySet<string>,
): Merged {
  const server = new Map(rows.map((row) => [row.workspace_id, row]))
  const layouts: Record<string, CachedLayout> = {}
  const changed = new Set<string>()
  for (const id of new Set([...Object.keys(local), ...server.keys()])) {
    const own = local[id]
    const row = server.get(id)
    if (own !== undefined && (busy.has(id) || own.dirty)) {
      layouts[id] = own
    } else if (row !== undefined) {
      layouts[id] = own?.revision === row.revision ? own : fromServer(row, own)
    } else if (own?.revision === 0 && own.panels.length > 0) {
      layouts[id] = { ...own, dirty: true }
    }
    if (layouts[id] !== own) {
      changed.add(id)
    }
  }
  return { layouts, changed }
}
