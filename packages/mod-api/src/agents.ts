import type { AgentColor, SubtaskBrief, TaskDisplayStatus, TaskListEntry, TerminalRef } from '@seti/shared'
import type { ComponentType, ReactNode } from 'react'
import type { ModAgentPlace, ModIcon, ModLazyView, ModSignal } from './ui.js'

/** One row of an agent's More actions menu. */
export interface ModAgentAction {
  label: string
  icon: ModIcon
  /** Shown at the row's end, such as how many processes run. */
  detail?: string
  /** Its key shortcut, shown in menus but not on the phone's sheet. */
  shortcut?: string
  /** The row's accessible name when it should say more than the label. */
  ariaLabel?: string
  onSelect: () => void
}

/** An agent view shown inside a mod's panel: the compact header, a short tail and keys on focus. */
export interface ModAgentFrame {
  id: string
  focused: boolean
  /** The header drags the frame, so it shows a grip. */
  draggable: boolean
  /** Rows the frame adds to the agent's More actions menu, after a separator. */
  menu: readonly ModAgentAction[]
}

/** One agent, or one of its subagents, as the agent page shows it. */
export interface ModAgentViewProps {
  task: TaskListEntry
  subId: string | null
  onChanged: () => void
  onSubtasks: (taskId: string, subtasks: readonly SubtaskBrief[]) => void
}

/** An agent as the list shows it: its running subagents and the status they give it. */
export interface ModAgentRow {
  task: TaskListEntry
  running: number
  status: TaskDisplayStatus
}

/** What a layout's view gets: the shown workspace's agents and what the address names. */
export interface ModAgentsLayoutProps {
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

/** The address as a layout sees it. */
export interface ModAgentsLayoutRoute {
  id: string | null
  terminal: string | null
  /** The agent is in the active list. */
  listed: boolean
  /** The agent list has loaded. */
  loaded: boolean
}

/** A way to show several agents at once, for a view the manifest places in `agentsLayout`. */
export interface ModAgentsLayout {
  /** The view's id in the manifest; its title and `phone` come from there. */
  id: string
  icon: ModIcon
  /** On for this device; Seti shows the layout instead of one agent while it is on. */
  active: ModSignal
  setActive: (on: boolean) => void
  /** The toggle's tooltip while it is on or off. */
  hint: (on: boolean) => string
  view: ModLazyView<ModAgentsLayoutProps>
  /** Whether it shows this address; false hands it to one agent's view, as for archived agents. */
  shows: (route: ModAgentsLayoutRoute) => boolean
  /** Tells Seti when what `shows`, `shownAgents` or `newTerminal` answer may have changed. */
  subscribe: (listener: () => void) => () => void
  /** The agents it shows, on screen for notices; the same array until they change. */
  shownAgents: () => readonly string[]
  /** Agent rows drag onto it, carrying the id under `api.agents.DRAG_TYPE`. */
  acceptsAgents: boolean
  /** The group chat floats over it instead of beside it. */
  overlay: boolean
  /** Takes in a terminal shown alone, from its "Open in" button; Seti turns the layout on first. */
  adoptTerminal?: (terminal: TerminalRef) => void
  /** What the Terminal button does while the layout is on screen. */
  newTerminal?: () => void
  /** The workspace the agent list shows, and the first one, for a layout kept per workspace. */
  showWorkspace?: (workspace: { id: string; first: string | null }) => void
}

/** Terminals a mod keeps, such as a layout's panels; Seti lists them beside the device's own. */
export interface ModTerminalSource {
  id: string
  /** Shown beside its terminals in the terminal switcher, such as "in grid". */
  label: string
  /** Its terminals; the same array until they change. */
  list: () => readonly TerminalRef[]
  subscribe: (listener: () => void) => () => void
  refresh?: () => Promise<void>
  /** Ends the terminal's shell and takes it out of the source. */
  close: (id: string) => void
  rename: (id: string, name: string) => void
}

/** Seti's agents as a mod's UI half reaches them: their views and list pieces. */
export interface ModAgents {
  /** One agent or subagent behind an error boundary. */
  View: ComponentType<ModAgentViewProps>
  /** Frames the agent view inside it; its commands, find and Esc work only while focused. */
  Frame: ComponentType<{ frame: ModAgentFrame; children: ReactNode }>
  /** Lets the framed agents inside it open Files in one shared dock over its right edge. */
  FilesDockHost: ComponentType<{ titleOf: (taskId: string) => string; children: ReactNode }>
  /** The status glyph; `agent` and `place` let a mod's status marker draw it as that agent. */
  StatusLight: ComponentType<{
    status: TaskDisplayStatus
    place: ModAgentPlace
    subagents?: number
    agent?: { id: string; color: AgentColor | null }
  }>
  UnseenDot: ComponentType
  /** The attribute that gives an element its agent's colour. */
  colorAttr: (color: AgentColor | null) => Record<string, string>
  /** Rows whose title, repos or folder, status words or colour hold every term of the query. */
  filter: (rows: readonly ModAgentRow[], query: string) => ModAgentRow[]
  /** The repo names without owners, or the folder name. */
  placeLabel: (task: Pick<TaskListEntry, 'cwd' | 'repos'>) => string
  /** The drag data type of an agent row. */
  DRAG_TYPE: string
  /** Shows the agent, as a link to it does, or the Agents section without one. */
  open: (id?: string) => void
  /** Sends the agent a message as the user, as its reply box does. */
  send: (agent: string, prompt: string) => Promise<void>
  /** Opens one of the mod's docks over the agent's chat, or focuses it when it is open. */
  openDock: (agent: string, dock: string) => void
  closeDock: (agent: string, dock: string) => void
}

/** Where a terminal's shell starts: an agent's folder, or home. */
export interface ModTerminalPlace {
  taskId: string | null
  name: string
}

/** Seti's terminals, for a mod that shows them in its own panels. */
export interface ModTerminals {
  /** A terminal's shell, loading xterm on first use. */
  View: ComponentType<{
    tab: { id: string; taskId: string | null }
    active: boolean
    softKeys: boolean
    takeFocus?: boolean
    primary?: boolean
    onReady?: (where: { cwd: string; sandboxed: boolean }) => void
    findRequest?: number
  }>
  /** Edits a terminal's name in place: Enter or leaving keeps it, Escape cancels. */
  Name: ComponentType<{
    name: string
    label: string
    onCommit: (name: string) => void
    onDone: () => void
    className?: string
  }>
  /** A new terminal in `place`, named apart from every terminal Seti knows; it starts once shown. */
  mint: (place: ModTerminalPlace) => TerminalRef
  readonly HOME: ModTerminalPlace
  /** Takes a terminal into this device's own list; false once the list is full. */
  adopt: (terminal: TerminalRef) => boolean
  /** Takes a terminal out of this device's own list; its shell keeps running. */
  release: (id: string) => void
  /** Ends a terminal's shell. */
  stop: (id: string) => Promise<void>
  /** Lets the terminal start a new shell the next time it shows. */
  allowStart: (id: string) => void
  /** Shows the terminal alone. */
  openAlone: (id: string) => void
  /** This device's own terminals, outside every source; a hook. */
  useOwn: () => readonly TerminalRef[]
}
