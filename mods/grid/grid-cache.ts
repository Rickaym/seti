import { isRecord } from '@seti/mod-api'
import { PER_SCREEN } from './grid-layout'
import { migrateCells, parsePanels } from './grid-storage'
import { EMPTY_LAYOUT, type CachedLayout } from './grid-sync'

/** Every workspace's grid as this device last had it. */
export interface StoredGrids {
  enabled: boolean
  layouts: Readonly<Record<string, CachedLayout>>
  /** A grid saved before workspaces, until the first workspace takes it. */
  unclaimed: CachedLayout | null
}

export const GRID_KEY = 'seti.agents.grid'

/** Stored grids carry this; older ones were this device's own, from before the server kept them. */
const VERSION = 4

export const RECENT_MAX = 16

export const EMPTY_STORE: StoredGrids = { enabled: false, layouts: {}, unclaimed: null }

const readPerScreen = (value: unknown): number | null =>
  typeof value === 'number' && PER_SCREEN.includes(value) ? value : null

const readRecent = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string').slice(0, RECENT_MAX) : []

function readLayout(value: unknown, synced: boolean): CachedLayout | null {
  if (!isRecord(value)) {
    return null
  }
  const panels = parsePanels(value.panels)
  if (panels === null) {
    return null
  }
  const focused = panels.some((panel) => panel.i === value.focused) ? (value.focused as string) : null
  const revision = typeof value.revision === 'number' && Number.isInteger(value.revision) ? value.revision : 0
  return {
    panels,
    locked: value.locked === true,
    perScreen: readPerScreen(value.perScreen),
    focused: focused ?? panels[0]?.i ?? null,
    recent: readRecent(value.recent),
    revision: synced ? Math.max(0, revision) : 0,
    dirty: synced && value.dirty === true,
  }
}

function readLayouts(value: unknown, synced: boolean): Record<string, CachedLayout> {
  const entries = isRecord(value) ? Object.entries(value) : []
  return Object.fromEntries(
    entries.flatMap(([id, stored]) => {
      const layout = readLayout(stored, synced)
      return layout === null ? [] : [[id, layout]]
    }),
  )
}

/** The grids as last stored, one grid from before workspaces kept unclaimed, or off and empty. */
export function readGridStore(): StoredGrids {
  try {
    const raw = localStorage.getItem(GRID_KEY)
    if (raw === null) {
      return EMPTY_STORE
    }
    const stored = JSON.parse(raw) as Record<string, unknown>
    const enabled = stored.enabled === true
    if (stored.v === VERSION || stored.v === 3) {
      const synced = stored.v === VERSION
      return {
        enabled,
        layouts: readLayouts(stored.workspaces, synced),
        unclaimed: readLayout(stored.unclaimed, false),
      }
    }
    if (stored.v === 2) {
      const layout = readLayout(stored, false)
      return layout === null ? EMPTY_STORE : { enabled, layouts: {}, unclaimed: layout }
    }
    const migrated = migrateCells(stored.layout, stored.focused)
    return migrated === null
      ? EMPTY_STORE
      : { enabled, layouts: {}, unclaimed: { ...EMPTY_LAYOUT, recent: readRecent(stored.recent), ...migrated } }
  } catch {
    return EMPTY_STORE
  }
}

export function writeGrids(next: StoredGrids): void {
  const { enabled, layouts, unclaimed } = next
  try {
    localStorage.setItem(
      GRID_KEY,
      JSON.stringify({ v: VERSION, enabled, workspaces: layouts, ...(unclaimed === null ? {} : { unclaimed }) }),
    )
  } catch {
    // Storage can be blocked; the grid then lasts for this visit only.
  }
}
