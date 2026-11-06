import type { ModSignal } from '@seti/mod-api'
import { Registry, type Disposer, type SubtaskBrief, type TaskListEntry, type TerminalRef } from '@seti/shared'
import { useSyncExternalStore, type ComponentType } from 'react'
import { TERMINAL_ROUTE } from '@/lib/route'
import { chosenWorkspace } from '@/panels/tasks/workspaces/workspace-store'

/** What a layout gets to show: the shown workspace's agents and what the address names. */
interface AgentsLayoutProps {
  tasks: readonly TaskListEntry[]
  loaded: boolean
  /** The agent the address names, which the layout shows and focuses. */
  routeId: string | null
  subId: string | null
  /** The terminal the address names, which the layout holds and focuses. */
  terminalId: string | null
  onChanged: () => void
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
}

/** The address as a layout sees it, to say whether it shows it or hands it to one agent's view. */
interface AgentsLayoutRoute {
  /** The agent the address names; null on the bare Agents page or for a terminal. */
  id: string | null
  /** The terminal the address names, or null. */
  terminal: string | null
  /** The agent is in the active list. */
  listed: boolean
  /** The agent list has loaded. */
  loaded: boolean
}

/** A way to show several agents at once, which the Agents section shows instead of one agent. */
export interface AgentsLayout {
  /** Unique, such as `<mod>.<view>`. */
  key: string
  title: string
  icon: ComponentType<{ className?: string }>
  /** On for this device. */
  active: ModSignal
  setActive: (on: boolean) => void
  /** The toggle's tooltip while it is on or off. */
  hint: (on: boolean) => string
  /** Whether narrow screens show it; when false, phones keep one agent. */
  phone: boolean
  view: ComponentType<AgentsLayoutProps>
  /** Whether it shows this address; false hands it to one agent's view, as for archived agents. */
  shows: (route: AgentsLayoutRoute) => boolean
  /** Tells it when what `shows`, `shownAgents` or `newTerminal` answer may have changed. */
  subscribe: (listener: () => void) => Disposer
  /** The agents it shows, on screen for notices; the same array until they change. */
  shownAgents: () => readonly string[]
  /** Agent rows drag onto it. */
  acceptsAgents: boolean
  /** The group chat floats over it instead of beside it. */
  overlay: boolean
  /** Takes in a terminal shown alone, from its "Open in" button; Seti turns the layout on first. */
  adoptTerminal?: (terminal: TerminalRef) => void
  /** What the Terminal button does while the layout is on screen, such as adding a panel. */
  newTerminal?: () => void
  /** The workspace the agent list shows, and the first one, for a layout kept per workspace. */
  showWorkspace?: (workspace: { id: string; first: string | null }) => void
}

export const agentsLayouts = new Registry<AgentsLayout>('agents layout', (layout) => layout.key)

/** Turns `layout` on or off, and every other one off when it turns on, so at most one is on. */
export function setLayoutActive(layout: AgentsLayout, on: boolean): void {
  if (on) {
    for (const other of agentsLayouts.list()) {
      if (other !== layout && other.active.get()) {
        other.setActive(false)
      }
    }
  }
  layout.setActive(on)
}

/** The layout on for this device that this screen can show, or null for one agent at a time. */
export const activeLayout = (narrow: boolean): AgentsLayout | null =>
  agentsLayouts.list().find((layout) => (layout.phone || !narrow) && layout.active.get()) ?? null

/** Listens to the registry and to every registered layout's on and off state. */
function subscribeLayouts(listener: () => void): Disposer {
  let each: Disposer[] = []
  const listen = () => {
    for (const dispose of each) {
      dispose()
    }
    each = agentsLayouts.list().map((layout) => layout.active.subscribe(listener))
  }
  listen()
  const registry = agentsLayouts.subscribe(() => {
    listen()
    listener()
  })
  return () => {
    registry()
    for (const dispose of each) {
      dispose()
    }
  }
}

/** The layout the Agents section shows, as layouts register and turn on and off. */
export function useActiveLayout(narrow: boolean): AgentsLayout | null {
  return useSyncExternalStore(subscribeLayouts, () => activeLayout(narrow))
}

/** Layouts this screen can show, for their toggles; phones get only those that allow them. */
export function useLayouts(narrow: boolean): readonly AgentsLayout[] {
  const all = useSyncExternalStore(agentsLayouts.subscribe, agentsLayouts.list)
  return narrow ? all.filter((layout) => layout.phone) : all
}

const NONE: readonly string[] = []
const noLayout = (): Disposer => () => undefined

/** Whether the active layout shows this address, as what it holds changes. */
function useLayoutShows(layout: AgentsLayout | null, route: AgentsLayoutRoute): boolean {
  return useSyncExternalStore(layout?.subscribe ?? noLayout, () => layout?.shows(route) ?? false)
}

/** The agents the active layout shows now, none without one. */
export function useLayoutAgents(layout: AgentsLayout | null): readonly string[] {
  return useSyncExternalStore(layout?.subscribe ?? noLayout, () => layout?.shownAgents() ?? NONE)
}

interface AddressAgents {
  selectedId: string | null
  terminalId: string | null
  /** The agent the address names is in the active list. */
  listed: boolean
  loaded: boolean
}

/**
 * Where the address shows: in the active layout, which gets the agent or terminal it names, or
 * on its own, where `alone` names a terminal the layout does not hold.
 */
export function useLayoutPlace(layout: AgentsLayout | null, { selectedId, terminalId, listed, loaded }: AddressAgents) {
  const named = selectedId === TERMINAL_ROUTE ? (terminalId ?? '') : null
  const inLayout = useLayoutShows(
    layout,
    named === null
      ? { id: selectedId, terminal: null, listed, loaded }
      : { id: null, terminal: named, listed: false, loaded },
  )
  return {
    inLayout,
    alone: named !== null && !inLayout ? named : null,
    routeId: named === null ? selectedId : null,
    terminalId: named,
  }
}

const chosen = chosenWorkspace()

/** Until the agent list says which, the workspace this device chose, with no first known yet. */
let shownWorkspace: { id: string; first: string | null } | null = chosen === null ? null : { id: chosen, first: null }
const told = new WeakMap<AgentsLayout, { id: string; first: string | null }>()

/** Tells each layout the shown workspace, once per change. */
const tellWorkspace = () => {
  const workspace = shownWorkspace
  if (workspace === null) {
    return
  }
  for (const layout of agentsLayouts.list()) {
    if (told.get(layout) !== workspace) {
      told.set(layout, workspace)
      layout.showWorkspace?.(workspace)
    }
  }
}

agentsLayouts.subscribe(tellWorkspace)

/** Tells every layout, and each one registered later, which workspace the agent list shows. */
export function showLayoutsWorkspace(id: string, first: string | null): void {
  shownWorkspace = { id, first }
  tellWorkspace()
}
