import type { Disposer, FileKind, ModManifest, PullRequest, TaskDisplayStatus } from '@seti/shared'
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  ComponentType,
  HTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactElement,
  ReactNode,
  Ref,
} from 'react'
import type { ModAgents, ModAgentsLayout, ModTerminals, ModTerminalSource } from './agents.js'

/** A lucide icon, or any component that takes a class name the same way. */
export type ModIcon = ComponentType<{ className?: string }>

/** The theme a view draws in: read colours from Seti's CSS custom properties when `key` changes. */
export interface ModViewTheme {
  /** Changes whenever the theme, its flavour or accent, or light and dark changes. */
  key: string
  dark: boolean
}

/** What a file viewer gets: the file, where to load it from, and the theme. */
export interface ModFileViewProps {
  name: string
  kind: FileKind
  size: number
  /** When the file last changed; a new value means new content. */
  mtime: string
  /** The file's bytes, for loading into the viewer. */
  url: string
  /** The same file as a download. */
  download: string
  /** The file as a sandboxed page for a frame, when the viewer declared `page`; else null. */
  page: string | null
  /** The file's text when the viewer declared `text` and Seti read it (up to 2 MB); else null. */
  text: string | null
  /** The line a search opened the file at, counted from 1, or null. */
  line: number | null
  /** The user is editing the file, and this view shows the saved version under the editor. */
  editing: boolean
  theme: ModViewTheme
}

/** What a Markdown fence renderer gets: the fenced block's text. */
export interface ModFenceProps {
  source: string
  theme: ModViewTheme
}

/** The colour scheme of a share page's viewer. */
export type ModColorScheme = 'light' | 'dark'

/**
 * Draws a fence as a standalone SVG for a share page, which runs no script: in colours for a
 * plain page of the scheme, with text as SVG text in a common sans font, since the server
 * rasterizes it. Null when the fence cannot be drawn, which leaves it as code.
 */
export type ModFenceSnapshot = (source: string, scheme: ModColorScheme) => Promise<string | null>

/** What a PR chip gets: the open PR it sits beside, in an agent's PR row. */
export interface ModPrChipProps {
  pr: PullRequest
}

/**
 * Where Seti draws an agent's marker or accent: list rows, Needs you, the grid, the legend, the
 * phone agent header or the Home page.
 */
export type ModAgentPlace = 'list' | 'needsYou' | 'grid' | 'legend' | 'header' | 'home'

/**
 * What a status marker gets: an agent's status, the agent when it stands for one, and where it
 * sits. Seti keeps the marker's name and tooltip, sets `--agent-stripe` to the agent's colour
 * when it has one, and sets `currentColor` to the status colour. A view that renders nothing
 * gives way to Seti's own shape there.
 */
export interface ModStatusMarkerProps {
  status: TaskDisplayStatus
  agent: { id: string; color: string | null } | null
  place: ModAgentPlace
}

/**
 * What an agent row accent gets: the agent, its status and its row's group. It sits near the
 * row's left edge in place of the colour bar and carries the status, so Seti hides the status
 * marker from sight while screen readers still read it. Seti gives the accent the marker's
 * tooltip, sets `--agent-stripe` to the agent's colour when it has one and `currentColor` to the
 * status colour. A view that renders nothing gives the row back its bar and marker; one that
 * renders only an element with `data-accent-blank` does the same but keeps that element's room.
 */
export interface ModAgentAccentProps {
  status: TaskDisplayStatus
  agent: { id: string; color: string | null }
  place: 'list' | 'needsYou'
}

/** A view given as its component, or loaded as its own chunk the first time Seti shows it. */
export type ModLazyView<P> = { view: ComponentType<P> } | { load: () => Promise<ComponentType<P>> }

/** What a settings page gets: its key in the address, and what follows it there. */
export interface ModSettingsPageProps {
  page: string
  detail: string | null
}

/** A section of the sidebar, as the address names it: `#<section>/<id>`. */
export interface ModSectionProps {
  id: string | null
}

/** A mod route Seti polls while a view reads it, and stops polling once none does. */
export interface ModPolled<T> {
  subscribe: (listener: () => void) => () => void
  /** The last answer, undefined before the first, and why the latest poll failed. */
  getSnapshot: () => { data: T | undefined; error: string | null }
  /** Polls now instead of waiting for the next turn. */
  refresh: () => void
}

/** Something that is on or off and says when it changes, such as whether news waits. */
export interface ModSignal {
  subscribe: (listener: () => void) => () => void
  get: () => boolean
}

/** Seti's own controls, so a bundled mod's views look and behave like the rest of Seti. */
export interface ModKit {
  Button: ComponentType<
    ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: 'outline' | 'ghost'
      size?: 'sm' | 'xs' | 'icon-sm' | 'icon-xs'
      /** Styles its one child, such as a link, as the button. */
      asChild?: boolean
    }
  >
  Input: ComponentType<InputHTMLAttributes<HTMLInputElement>>
  Textarea: ComponentType<ComponentProps<'textarea'>>
  /** A tooltip on its one child, which says more than the child's one-or-two-word label. */
  Hint: ComponentType<{ text: ReactNode; children: ReactElement }>
  /** A binary mode as one pressed or unpressed button with an icon and a one-or-two-word label. */
  ToggleButton: ComponentType<{
    pressed: boolean
    onPressedChange: (pressed: boolean) => void
    icon: ReactElement
    label: string
    hint: ReactNode
    /** Shows the icon alone, keeping the label for screen readers. */
    iconOnly?: boolean
  }>
  CopyButton: ComponentType<{ text: string; label: string }>
  Markdown: ComponentType<{ text: string; className?: string }>
  /** A short uppercase label in a tone, as a PR row shows its CI state. */
  Tag: ComponentType<{ tone: 'success' | 'failure' | 'warning' | 'muted'; children: ReactNode }>
  /** An agent's reply as its transcript draws it: Markdown, file links and a copy button. */
  AgentText: ComponentType<{ text: string }>
  /** One quiet line of a transcript with its icon, such as a file read; `error` marks a failure. */
  Line: ComponentType<{ icon: ModIcon; error?: boolean; children: ReactNode }>
  /** The dot that marks something the user has not seen yet. */
  NewsDot: ComponentType<{ className?: string }>
  /** A failure toast, which stays until the user dismisses it. */
  fail: (title: string, description?: string) => void
  /** A short toast that something worked, such as a copy. */
  succeed: (title: string) => void
  /** Puts its children in the file viewer's header, beside Edit and Download. */
  ViewerActions: ComponentType<{ children: ReactNode }>
  /** A file's bytes from a viewer's `url`, failing with Seti's reason when it refuses. */
  fetchRaw: (url: string, signal: AbortSignal) => Promise<Response>
  /** The message of anything thrown, for a failure line. */
  errorText: (error: unknown) => string
  /** Joins class names, letting later Tailwind classes win. */
  cn: (...classes: (string | false | null | undefined)[]) => string
  /** A dialog with a title, closed by Esc or a click outside. */
  Dialog: ComponentType<{
    open: boolean
    onOpenChange: (open: boolean) => void
    title: string
    className?: string
    children: ReactNode
  }>
  /** A status bar item: its hint shows on hover and, on a phone, in the status sheet. */
  StatusItem: ComponentType<{
    label: string
    name?: string
    tooltip: ReactNode
    tone?: 'default' | 'muted'
    onClick?: () => void
    children: ReactNode
  }>
  /** A status item's hint, with a bold first line. */
  StatusHint: ComponentType<{ title: ReactNode; children?: ReactNode }>
  /** A menu on a trigger, with plain rows and a group of radio rows. */
  DropdownMenu: ModDropdownMenu
  /** A filtered list with a search field, as the palette and pickers use. */
  Command: ModCommandList
  /** A toast that goes by itself, with an optional action such as Undo. */
  toast: (message: string, options?: { description?: string; action?: { label: string; onClick: () => void } }) => void
}

export interface ModDropdownMenu {
  Root: ComponentType<{ modal?: boolean; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }>
  Trigger: ComponentType<{ asChild?: boolean; children: ReactNode }>
  Content: ComponentType<{ align?: 'start' | 'center' | 'end'; className?: string; children: ReactNode }>
  Item: ComponentType<{ onSelect?: () => void; disabled?: boolean; className?: string; children: ReactNode }>
  Separator: ComponentType
  RadioGroup: ComponentType<{ value: string; onValueChange: (value: string) => void; children: ReactNode }>
  RadioItem: ComponentType<{ value: string; className?: string; children: ReactNode }>
}

export interface ModCommandList {
  Root: ComponentType<{
    shouldFilter?: boolean
    loop?: boolean
    label?: string
    className?: string
    onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
    children: ReactNode
  }>
  Input: ComponentType<
    Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
      value?: string
      onValueChange?: (value: string) => void
      ref?: Ref<HTMLInputElement>
    }
  >
  List: ComponentType<{ className?: string; children: ReactNode }>
  Item: ComponentType<
    Omit<HTMLAttributes<HTMLDivElement>, 'onSelect'> & { value?: string; onSelect?: () => void; disabled?: boolean }
  >
  Empty: ComponentType<{ children: ReactNode }>
}

/** Where a command runs in the UI: the agent the page shows, if any, and where the user is. */
export interface ModCommandContext {
  /** The id of the agent the page or composer is for, or null. */
  agent: string | null
  /** The sidebar section the page shows, such as `agents`. */
  section: string
  /** The layout shows one pane at a time, as on a phone. */
  narrow: boolean
}

/** Why a command waits on an agent now, such as an answer still streaming, and when that changes. */
export interface ModCommandWaits {
  subscribe: (listener: () => void) => () => void
  /** The line the reply box shows while the command waits on the agent; null when it can run. */
  reason: (agent: string) => string | null
}

/** How the UI runs a command the manifest declares, in place of calling the server half. */
export interface ModUiCommand {
  id: string
  icon?: ModIcon
  /** Runs it in the UI, such as opening a view; without it Seti calls the server half. */
  run?: (args: Record<string, unknown>, context: ModCommandContext) => void | Promise<void>
  /** Offers it only where this answers true, in the palette, the agent header and its chord. */
  when?: (context: ModCommandContext) => boolean
  /** Its title here, when it reads differently by state, such as Unlock while locked. */
  title?: (context: ModCommandContext) => string
  /** Holds its slash command in the reply box while it waits, with the reason. */
  waits?: ModCommandWaits
  /** What the reply box says its slash command will do with these arguments. */
  status?: (args: Record<string, unknown>) => string
}

/** A key a mod's view binds while it shows, written as in the manifest, such as `Alt+Left`. */
export interface ModKeyBinding {
  chord: string
  run: () => void
}

/** The agent a dock is open over. */
export interface ModDockAgent {
  id: string
  title: string
}

/** What a dock view gets: its agent, and how to close it. */
export interface ModDockProps {
  agent: ModDockAgent
  /** Changes each time the dock is opened again, so the view can focus its field. */
  focus: number
  close: () => void
}

/** A dock the manifest places in `agentDock`: Seti draws its frame, header and close button. */
export interface ModDock {
  id: string
  icon: ModIcon
  view: ComponentType<ModDockProps>
  /** Runs when the dock closes, or the agent's view goes away, so the mod can drop what it held. */
  onClose?: (agent: string) => void
}

/** Keyboard behaviour a bundled mod adds, such as Vim mode; Seti calls it for every key. */
export interface ModInputHook {
  id: string
  /** Sees each keydown Seti does not take itself; preventDefault claims the key. */
  onKeyDown?: (e: KeyboardEvent) => void
  /** True when this Esc is the hook's, so Seti's own Esc, such as stopping an agent, skips it. */
  takesEscape?: (e: KeyboardEvent) => boolean
  /** Enter in a chat's find field; true when the hook took it instead of stepping to the match. */
  onFindEnter?: (field: HTMLElement, e: { shiftKey: boolean }) => boolean
  /** Drawn above the page while the hook is registered, such as a dialog that lists its keys. */
  overlay?: ComponentType
}

/** A chat's find bar, for keys that open, step and close it. */
export interface ModChatFind {
  isOpen: () => boolean
  open: () => void
  step: (direction: 'older' | 'newer') => void
  close: () => void
}

/** Seti's panels as the focus API marks them, for mods that move focus between them. */
export interface ModPanels {
  /** The panel holding `node`, the innermost when panels nest. */
  panelOf: (node: Element | null) => HTMLElement | null
  /** Panels on screen that hold no other panel, in reading order. */
  visible: () => HTMLElement[]
  /** The panel above or below `from` that overlaps it most across. */
  beside: (from: HTMLElement, panels: readonly HTMLElement[], direction: 1 | -1) => HTMLElement | null
  /** The panel's scroll area, and how to move it to its newest content. */
  scrollerOf: (panel: HTMLElement) => HTMLElement | null
  scrollToBottom: (scroller: HTMLElement) => void
  /** The panel's reply box, else its first field; and its own search field. */
  composerOf: (panel: HTMLElement) => HTMLTextAreaElement | HTMLInputElement | null
  searchFieldOf: (panel: HTMLElement) => HTMLInputElement | null
  /** What the panel offers beyond scrolling, such as opening its Files. */
  actionsOf: (panel: HTMLElement) => { toggleFiles?: () => void }
  /** Focus is where every key belongs to someone else, such as a terminal. */
  isPassthrough: (target: EventTarget | null) => boolean
  /** A dialog, popover or menu owns the keys. */
  overlayOpen: () => boolean
  /** The panel the page itself has selected, such as a layout's focused panel; else null. */
  selected: () => HTMLElement | null
  /** Marks the panel keyboard focus is in, or clears the mark with null. */
  markActive: (panel: HTMLElement | null) => void
  /** The find bar of the chat the panel shows, or null when it shows none. */
  findOf: (panel: HTMLElement) => ModChatFind | null
  /** The attributes that make an element one of these panels. */
  readonly markers: ModPanelMarkers
  /** Where focus lands when the page opens: the element `resolve` picks inside the page, or null. */
  setLandingArea: (resolve: ((root: HTMLElement) => HTMLElement | null) | null) => void
}

/** The attributes of Seti's focus API, for a mod that draws panels of its own. */
export interface ModPanelMarkers {
  /** A panel focus moves between. */
  PANEL: Readonly<Record<string, string>>
  /** A panel whose keys all belong to what it holds, such as a terminal. */
  PANEL_PASSTHROUGH: Readonly<Record<string, string>>
  /** Marks the panel a layout of several holds as focused. */
  focused: (focused: boolean) => Readonly<Record<string, boolean>>
}

/** Seti's own actions and layout, for input hooks that drive the app from keys. */
export interface ModApp {
  /** On while the layout shows one pane at a time, as on a phone. */
  readonly narrow: ModSignal
  /** Focus is in a field that takes text. */
  isTyping: (target: EventTarget | null) => boolean
  /** Opens the command palette at its commands. */
  openCommands: () => void
  toggleGroupChat: () => void
  /** Keeps focus where a key just put it, instead of where the next page would put it. */
  holdFocus: () => void
  /** Runs `run` each interval, paused offline or while the page is hidden; returns the stop. */
  every: (run: () => void, intervalMs: number) => () => void
}

/** Keys a mod binds, and how this device names a chord written as in the manifest. */
export interface ModKeys {
  /** Binds keys while the calling view shows; a hook. */
  useChords: (bindings: readonly ModKeyBinding[]) => void
  /** The chord as this device names it, such as `Opt+G` on Apple. */
  label: (chord: string) => string
  /** The chord for `aria-keyshortcuts`. */
  aria: (chord: string) => string
}

/**
 * What a bundled mod's UI half registers. Each id names an entry its manifest declares, and each
 * registration returns a disposer; Seti also undoes every one when the mod is turned off.
 */
export interface UiModApi {
  readonly id: string
  readonly manifest: ModManifest
  /** A section of the sidebar, for a view the manifest places in `section`. */
  registerSection: (section: { id: string; icon: ModIcon; view: ComponentType<ModSectionProps> }) => Disposer
  /** A dock over an agent's chat, for a view the manifest places in `agentDock`. */
  registerDock: (dock: ModDock) => Disposer
  /** A view the manifest places in `header` (the app header's band) or `about` (Settings, About). */
  registerView: (view: { id: string; view: ComponentType }) => Disposer
  /** A dot on the way to one of its `about` views, in the sidebar and Settings, while `news` is on. */
  registerNews: (news: { view: string; news: ModSignal }) => Disposer
  /** The mod's page in Settings, in place of the form Seti draws from its settings. */
  registerSettingsPage: (page: {
    icon: ModIcon
    keywords?: string
    view: ComponentType<ModSettingsPageProps>
  }) => Disposer
  /** The component of a status bar item the manifest declares. */
  registerStatusBarItem: (item: { id: string; view: ComponentType }) => Disposer
  /** The component of a file viewer the manifest declares; it wins over Seti's own viewer. */
  registerFileViewer: (viewer: { id: string } & ModLazyView<ModFileViewProps>) => Disposer
  /**
   * The component that draws Markdown fences of a language the manifest declares, and how to
   * draw one for a share page; without `snapshot` a shared fence shows as code.
   */
  registerFenceRenderer: (
    renderer: { language: string; snapshot?: ModFenceSnapshot } & ModLazyView<ModFenceProps>,
  ) => Disposer
  /** A way to show several agents at once, for a view the manifest places in `agentsLayout`. */
  registerAgentsLayout: (layout: ModAgentsLayout) => Disposer
  /** Terminals the mod keeps, listed beside the device's own in the terminal switcher. */
  registerTerminalSource: (source: ModTerminalSource) => Disposer
  /** A chip beside each open PR in an agent's PR row, for a PR chip the manifest declares. */
  registerPrChip: (chip: { id: string; view: ComponentType<ModPrChipProps> }) => Disposer
  /** Draws agents' status markers in place of Seti's shapes; bundled mods only. */
  registerStatusMarker: (marker: { id: string; view: ComponentType<ModStatusMarkerProps> }) => Disposer
  /** Draws an accent on each agent row's left edge in place of its colour bar; bundled only. */
  registerAgentAccent: (accent: { id: string; view: ComponentType<ModAgentAccentProps> }) => Disposer
  /** The icon of a command the manifest declares, and how the UI runs it, if not on the server. */
  registerCommand: (command: ModUiCommand) => Disposer
  /** Runs one of its commands as the user, as the palette does; answers the line Seti shows. */
  runCommand: (id: string, args?: Record<string, unknown>) => Promise<string>
  /** Keyboard behaviour an input hook the manifest declares adds; bundled mods only. */
  registerInputHook: (hook: ModInputHook) => Disposer
  /** Seti's panels, for moving focus between them. */
  readonly panels: ModPanels
  /** Seti's own actions and layout, for input hooks. */
  readonly app: ModApp
  /** Seti's agent views, list pieces, messages and docks; bundled mods only. */
  readonly agents: ModAgents
  /** Seti's terminals; bundled mods only. */
  readonly terminals: ModTerminals
  /** Keys a view binds while it shows; a hook, and the manifest's `shortcuts` list them. */
  readonly keys: ModKeys
  /** Calls one of the mod's own routes under /api/mods/<id>/. */
  request: <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<T>
  /**
   * Posts to one of its `stream` routes and hands over each event's data as it arrives; ends when
   * the stream does, and fails with Seti's reason when the route refuses.
   */
  stream: (path: string, body: unknown, onEvent: (data: unknown) => void, signal: AbortSignal) => Promise<void>
  /** One of its own GET routes, polled every `intervalMs` (at least 10 s) while a view reads it. */
  poll: <T>(path: string, intervalMs: number) => ModPolled<T>
  /** A hook: its settings as saved, each unset one at the manifest's default; null until loaded. */
  useSettings: () => Record<string, unknown> | null
  /** Saves some of its settings as the user, as its page in Settings does. */
  saveSettings: (values: Record<string, unknown>) => Promise<void>
  /** Seti's controls for its views. */
  readonly kit: ModKit
  /** Runs when the mod is turned off, for timers and the like. */
  onDispose: (dispose: Disposer) => void
}
