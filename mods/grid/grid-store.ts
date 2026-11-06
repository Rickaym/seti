import { isRecord, type TerminalRef, type WorkspaceGrid } from '@seti/mod-api'
import { useEffect, useSyncExternalStore } from 'react'
import { EMPTY_STORE, readGridStore, RECENT_MAX, writeGrids, type StoredGrids } from './grid-cache'
import {
  addPanel,
  assign,
  metrics,
  nextSlot,
  prune,
  removePanel,
  renamedTerminal,
  samePanels,
  tidy,
  tidyTemplate,
  withTerminal,
  type Metrics,
  type Panel,
  type Room,
} from './grid-layout'
import { EMPTY_LAYOUT, mergeServer, type CachedLayout, type Layout } from './grid-sync'
import { seti } from './seti'

export interface GridState extends Layout {
  /** The Agents section shows the grid instead of one agent; phones ignore it. */
  enabled: boolean
}

/** Edits that come in a burst, such as tidy then lock, go to the server as one save. */
const SAVE_DELAY_MS = 800

const RETRY_MS = 10_000

const POLL_MS = 30_000

let grids = readGridStore()
if (grids !== EMPTY_STORE) {
  writeGrids(grids)
}
/** The workspace Seti shows, until it says which: the grid saved before workspaces stands in. */
let workspace: string | null = null

/** What the server said when it refused a request, as Seti's request errors carry it. */
const refusal = (e: unknown) =>
  isRecord(e) && typeof e.status === 'number' ? { status: e.status, reason: String(e.message) } : null

/** The core route answers this when the workspace is gone, not when the grid mod is off. */
const WORKSPACE_GONE = 'Workspace not found'

const layoutOf = (id: string | null): CachedLayout =>
  (id === null ? grids.unclaimed : grids.layouts[id]) ?? EMPTY_LAYOUT

const viewOf = (enabled: boolean, { panels, locked, perScreen, focused, recent }: CachedLayout): GridState => ({
  enabled,
  panels,
  locked,
  perScreen,
  focused,
  recent,
})

let state: GridState = viewOf(grids.enabled, layoutOf(workspace))
let room: Room = { width: 0, height: 0 }
const listeners = new Set<() => void>()

/** The server's grids came in, or proved out of reach, since the grid opened. */
let ready = false
/** Grids from the server at least once this visit. */
let loaded = false
/** The latest grids from the server, while no save of ours has landed since. */
let latest: readonly WorkspaceGrid[] | null = null
/** Counts the saves that landed, so an answer from before one is not taken as current. */
let landed = 0
/** Edits per workspace, so a save knows whether the grid changed again while it was on its way. */
const edits = new Map<string, number>()
const saving = new Set<string>()
/** Reasons the shown grid must not change under the user, such as a drag in progress. */
const holds = new Set<string>()
let saveTimer: ReturnType<typeof setTimeout> | undefined

const notify = () => {
  for (const listener of listeners) {
    listener()
  }
}

function setGrids(next: StoredGrids): void {
  grids = next
  writeGrids(grids)
}

function setLayout(id: string, layout: CachedLayout | undefined): void {
  const rest = Object.fromEntries(Object.entries(grids.layouts).filter(([key]) => key !== id))
  setGrids({ ...grids, layouts: layout === undefined ? rest : { ...rest, [id]: layout } })
  if (id === workspace) {
    state = viewOf(state.enabled, layoutOf(id))
    notify()
  }
}

function scheduleSave(delay = SAVE_DELAY_MS): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, delay)
}

async function save(id: string, layout: CachedLayout): Promise<void> {
  saving.add(id)
  const sent = edits.get(id) ?? 0
  let retry = false
  try {
    const row = await seti().request<WorkspaceGrid>('PUT', `/layouts/${id}`, {
      layout: { panels: layout.panels, locked: layout.locked, perScreen: layout.perScreen },
    })
    landed += 1
    latest = null
    const current = grids.layouts[id]
    if (current !== undefined) {
      setGrids({
        ...grids,
        layouts: {
          ...grids.layouts,
          [id]: { ...current, revision: row.revision, dirty: (edits.get(id) ?? 0) !== sent },
        },
      })
    }
  } catch (e) {
    const refused = refusal(e)
    if (refused?.status === 404 && refused.reason === WORKSPACE_GONE) {
      setLayout(id, undefined)
    } else {
      retry = refused === null || refused.status >= 500
    }
  } finally {
    saving.delete(id)
  }
  if (retry) {
    scheduleSave(RETRY_MS)
  } else if (grids.layouts[id]?.dirty === true) {
    scheduleSave()
  }
}

/** Sends every grid changed here to the server, unless the user is still arranging one. */
function flush(): void {
  clearTimeout(saveTimer)
  saveTimer = undefined
  if (holds.size > 0) {
    return
  }
  for (const [id, layout] of Object.entries(grids.layouts)) {
    if (layout.dirty && !saving.has(id)) {
      void save(id, layout)
    }
  }
}

function applyServer(rows: readonly WorkspaceGrid[]): void {
  const busy = new Set(saving)
  if (holds.size > 0 && workspace !== null) {
    busy.add(workspace)
  }
  const merged = mergeServer(grids.layouts, rows, busy)
  if (merged.changed.size === 0) {
    return
  }
  setGrids({ ...grids, layouts: merged.layouts })
  if (Object.values(merged.layouts).some((layout) => layout.dirty)) {
    scheduleSave(0)
  }
  if (workspace !== null && merged.changed.has(workspace)) {
    state = viewOf(state.enabled, layoutOf(workspace))
    notify()
  }
}

function markReady(): void {
  if (!ready) {
    ready = true
    notify()
  }
}

/** Takes the grids every device shares; edits made here and not yet saved stay. */
async function refresh(): Promise<void> {
  const before = landed
  try {
    const rows = await seti().request<WorkspaceGrid[]>('GET', '/layouts')
    if (before !== landed) {
      void refresh()
      return
    }
    loaded = true
    latest = rows
    applyServer(rows)
  } catch {
    // The server is out of reach; the grids from this device's last visit stand in.
  }
  markReady()
}

/** Keeps the grids in step with the server while the grid shows; returns the stop. */
function startSync(): () => void {
  void refresh()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') {
      flush()
    }
  }
  const onFocus = () => {
    void refresh()
  }
  const stopPolling = seti().app.every(() => void refresh(), POLL_MS)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('focus', onFocus)
  return () => {
    ready = false
    stopPolling()
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    holds.clear()
    flush()
  }
}

/** Changes the shown grid; a change to a shared field goes to the server unless `local`. */
function update(next: GridState, local = false): void {
  if (next === state) {
    return
  }
  const shared =
    !local && (next.panels !== state.panels || next.locked !== state.locked || next.perScreen !== state.perScreen)
  state = next
  const { enabled, ...layout } = next
  const before = layoutOf(workspace)
  const cached: CachedLayout = { ...layout, revision: before.revision, dirty: before.dirty || shared }
  setGrids(
    workspace === null
      ? { ...grids, enabled, unclaimed: cached }
      : { ...grids, enabled, layouts: { ...grids.layouts, [workspace]: cached } },
  )
  if (shared && workspace !== null) {
    edits.set(workspace, (edits.get(workspace) ?? 0) + 1)
    scheduleSave()
  }
  notify()
}

const withPanels = (panels: readonly Panel[], from: GridState = state): GridState => {
  if (samePanels(panels, from.panels)) {
    return from
  }
  const focused = panels.some((panel) => panel.i === from.focused) ? from.focused : (panels[0]?.i ?? null)
  return { ...from, panels, focused }
}

/** The grid's size, or the window's while the grid is not on screen, as when a tab moves in. */
const roomNow = (): Room =>
  (room.width > 0 && room.height > 0) || typeof window === 'undefined'
    ? room
    : { width: window.innerWidth, height: window.innerHeight }

/** The panels laid out by the grid's template, or evenly in one screen without one. */
const tidied = ({ panels, perScreen }: GridState): Panel[] =>
  perScreen === null ? tidy(panels, metrics(room)) : tidyTemplate(panels, perScreen, metrics(room))

/** Under a template, a tidy grid stays tidy as panels come, so a short screen's rows even out. */
function keptTidy(before: readonly Panel[], after: Panel[], perScreen: number | null, m: Metrics): Panel[] {
  if (perScreen === null || !samePanels(before, tidyTemplate(before, perScreen, m))) {
    return after
  }
  return tidyTemplate(after, perScreen, m)
}

/** Adds a panel at the template's next slot, or wherever addPanel finds room. */
function added(agent: string | null, terminal?: TerminalRef): string {
  const m = metrics(roomNow())
  const { panels, perScreen } = state
  const at = perScreen === null ? null : nextSlot(panels, perScreen, m)
  const next = addPanel(panels, terminal ?? agent, m, at)
  update(withPanels(keptTidy(panels, next.panels, perScreen, m)))
  return next.id
}

export const gridStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => state,
  /**
   * Shows workspace `id`'s grid; the first workspace takes the grid saved before workspaces.
   * Grid mode itself stays as it is.
   */
  showWorkspace: (id: string, first: string | null) => {
    const unclaimed = id === first && grids.layouts[id] === undefined ? grids.unclaimed : null
    if (id === workspace && unclaimed === null) {
      return
    }
    if (unclaimed !== null) {
      const claimed = { ...unclaimed, revision: 0, dirty: loaded }
      setGrids({ ...grids, layouts: { ...grids.layouts, [id]: claimed }, unclaimed: null })
      if (loaded) {
        scheduleSave()
      }
    }
    workspace = id
    state = viewOf(state.enabled, layoutOf(id))
    notify()
  },
  /** Takes the server's grids now, as when this device comes back to the grid. */
  refresh,
  /** Saves edits waiting for the quiet moment now. */
  flush,
  /**
   * Keeps the shown grid as it is while `reason` holds, such as a drag; other devices' changes
   * and this device's saves wait until no reason holds.
   */
  hold: (reason: string, on: boolean) => {
    if (on === holds.has(reason)) {
      return
    }
    if (on) {
      holds.add(reason)
      return
    }
    holds.delete(reason)
    if (holds.size > 0) {
      return
    }
    if (workspace !== null && grids.layouts[workspace]?.dirty === true) {
      scheduleSave()
    } else if (latest !== null) {
      applyServer(latest)
    }
  },
  setEnabled: (enabled: boolean) => {
    update(enabled === state.enabled ? state : { ...state, enabled })
  },
  setLocked: (locked: boolean) => {
    update(locked === state.locked ? state : { ...state, locked })
  },
  setPanels: (panels: readonly Panel[]) => {
    update(withPanels(panels))
  },
  /**
   * Empties panels of agents this device no longer lists, here only: a list a moment behind
   * another device's must not take that device's new agents out of the shared grid.
   */
  prune: (live: ReadonlySet<string>) => {
    update(withPanels(prune(state.panels, live)), true)
  },
  /** The grid's size on screen, which placing and tidying panels go by. */
  measure: (next: Room) => {
    room = next
  },
  metrics: () => metrics(room),
  /** Adds a panel for `agent`, or finds the one it has; returns the panel's id. */
  open: (agent: string): string => {
    const own = state.panels.find((panel) => panel.agent === agent)
    return own === undefined ? added(agent) : own.i
  },
  /** Adds a panel for `terminal`, or finds the one it has; returns the panel's id. */
  openTerminal: (terminal: TerminalRef): string => {
    const own = state.panels.find((panel) => panel.terminal?.id === terminal.id)
    return own === undefined ? added(null, terminal) : own.i
  },
  /** Shows `terminal` in empty panel `id`. */
  setTerminal: (id: string, terminal: TerminalRef) => {
    update(withPanels(withTerminal(state.panels, id, terminal)))
  },
  renameTerminal: (id: string, name: string) => {
    update(withPanels(renamedTerminal(state.panels, id, name)))
  },
  assign: (id: string, agent: string | null) => {
    update(withPanels(assign(state.panels, id, agent)))
  },
  remove: (id: string) => {
    update(withPanels(removePanel(state.panels, id)))
  },
  tidy: () => {
    update(withPanels(tidied(state)))
  },
  /** Sets the most panels one screen holds, null for all in one, and tidies the grid to it. */
  setPerScreen: (perScreen: number | null) => {
    const next = perScreen === state.perScreen ? state : { ...state, perScreen }
    update(withPanels(tidied(next), next))
  },
  /** Empties the grid; returns what it held so a toast can put it back. */
  clear: (): GridState => {
    const before = state
    update({ ...state, panels: [], focused: null })
    return before
  },
  restore: (before: GridState) => {
    update({ ...state, panels: before.panels, focused: before.focused })
  },
  /** Focuses panel `id` and counts its agent as the latest focused. */
  focus: (id: string) => {
    const panel = state.panels.find((p) => p.i === id)
    if (panel === undefined) {
      return
    }
    const agent = panel.agent
    const recent =
      agent === null || state.recent[0] === agent
        ? state.recent
        : [agent, ...state.recent.filter((other) => other !== agent)].slice(0, RECENT_MAX)
    if (id !== state.focused || recent !== state.recent) {
      update({ ...state, focused: id, recent })
    }
  },
}

export const isInGrid = (agent: string): boolean => state.panels.some((panel) => panel.agent === agent)

export const useGrid = (): GridState => useSyncExternalStore(gridStore.subscribe, gridStore.getSnapshot)

const readySnapshot = () => ready

/** Keeps the grids in step with the server while mounted; true once the server's grids are in. */
export function useGridSync(): boolean {
  useEffect(() => startSync(), [])
  return useSyncExternalStore(gridStore.subscribe, readySnapshot)
}
