import type { Disposer, UiModApi } from '@seti/mod-api'
import { readKey, type KeyContext, type KeyResult, type Pending, type VimAction } from './keymap'
import { setVimActive, setVimHelpOpen, setVimMode, vimActive } from './vim-store'

const LINE_PX = 60

type PanelMove = Extract<VimAction, { type: 'panel' }>['to']

type Handlers = { [T in VimAction['type']]: (action: Extract<VimAction, { type: T }>, panel: HTMLElement) => void }

/** Actions that need no active panel. */
const PANEL_FREE = new Set<VimAction['type']>(['normal', 'help', 'palette', 'groupChat'])

/** The panel a move lands on, from the panels in reading order and where the active one sits. */
function landing(to: PanelMove | number, panels: readonly HTMLElement[], from: HTMLElement | null, api: UiModApi) {
  if (typeof to === 'number') {
    return panels[to]
  }
  const at = from === null ? -1 : panels.findIndex((panel) => panel === from || from.contains(panel))
  const current = panels[at]
  if (current === undefined) {
    return panels[0]
  }
  if (to === 'up' || to === 'down') {
    return api.panels.beside(current, panels, to === 'down' ? 1 : -1)
  }
  const index = { previous: at - 1, next: at + 1, first: 0, last: panels.length - 1 }[to]
  return panels[Math.max(0, Math.min(panels.length - 1, index))]
}

function scrollPanel(panel: HTMLElement, action: VimAction, api: UiModApi): void {
  const scroller = api.panels.scrollerOf(panel)
  if (scroller === null) {
    return
  }
  if (action.type === 'scroll') {
    const step = action.by === 'line' ? LINE_PX : scroller.clientHeight / 2
    scroller.scrollBy({ top: step * action.direction })
  } else if (action.type === 'edge') {
    if (action.to === 'top') {
      scroller.scrollTo({ top: 0 })
    } else {
      api.panels.scrollToBottom(scroller)
    }
  }
}

function insert(panel: HTMLElement, at: 'keep' | 'end', api: UiModApi): void {
  const field = api.panels.composerOf(panel)
  if (field === null) {
    return
  }
  field.focus({ preventScroll: true })
  if (at === 'end' && field.selectionStart !== null) {
    const end = field.value.length
    field.setSelectionRange(end, end)
  }
}

function find(panel: HTMLElement, api: UiModApi): void {
  const chat = api.panels.findOf(panel)
  if (chat !== null) {
    chat.open()
    return
  }
  const field = api.panels.searchFieldOf(panel)
  field?.focus()
  field?.select()
}

/** Vim keys for Seti's panels: the focus they follow and the actions keys run. */
export class VimKeys {
  /** The panel that last held focus, which stays active while focus rests on the page itself. */
  private lastPanel: HTMLElement | null = null
  private pending: Pending | null = null
  /** The last key a terminal asked about, read once however often it asks. */
  private terminalRead: { event: KeyboardEvent; result: KeyResult } | null = null
  private readonly api: UiModApi

  constructor(api: UiModApi) {
    this.api = api
  }

  private activePanel(): HTMLElement | null {
    const { panels } = this.api
    const focused = panels.panelOf(document.activeElement)
    if (focused !== null) {
      return focused
    }
    if (this.lastPanel?.isConnected === true && this.lastPanel.checkVisibility()) {
      return this.lastPanel
    }
    return panels.selected() ?? panels.visible()[0] ?? null
  }

  /** Moves focus to a panel without scrolling, in normal mode even when it holds a terminal. */
  private focusPanel(panel: HTMLElement): void {
    this.lastPanel = panel
    if (!panel.hasAttribute('tabindex')) {
      panel.setAttribute('tabindex', '-1')
    }
    panel.focus({ preventScroll: true })
    panel.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    this.api.panels.markActive(panel)
    this.api.app.holdFocus()
  }

  /** Leaves a field for its panel, so the next keys are Vim keys. */
  private enterNormalMode(field: Element): void {
    const panel = this.api.panels.panelOf(field)
    if (panel === null) {
      if (field instanceof HTMLElement) {
        field.blur()
      }
      return
    }
    this.focusPanel(panel)
  }

  private movePanel(to: PanelMove | number, from: HTMLElement | null): void {
    const next = landing(to, this.api.panels.visible(), from, this.api)
    if (next !== null && next !== undefined && next !== from) {
      this.focusPanel(next)
    }
  }

  private handlers(): Handlers {
    const { api } = this
    return {
      scroll: (action, panel) => {
        scrollPanel(panel, action, api)
      },
      edge: (action, panel) => {
        scrollPanel(panel, action, api)
      },
      panel: (action, panel) => {
        this.movePanel(action.to, panel)
      },
      panelAt: (action, panel) => {
        this.movePanel(action.index, panel)
      },
      insert: (action, panel) => {
        insert(panel, action.at, api)
      },
      find: (_action, panel) => {
        find(panel, api)
      },
      findStep: (action, panel) => {
        api.panels.findOf(panel)?.step(action.direction === 'next' ? 'older' : 'newer')
      },
      closeFind: (_action, panel) => {
        api.panels.findOf(panel)?.close()
      },
      normal: () => {
        if (document.activeElement !== null) {
          this.enterNormalMode(document.activeElement)
        }
      },
      help: () => {
        setVimHelpOpen(true)
      },
      palette: () => {
        api.app.openCommands()
      },
      files: (_action, panel) => {
        api.panels.actionsOf(panel).toggleFiles?.()
      },
      groupChat: () => {
        api.app.toggleGroupChat()
      },
    }
  }

  private run(action: VimAction, panel: HTMLElement | null): void {
    if (panel === null && !PANEL_FREE.has(action.type)) {
      return
    }
    const handle = this.handlers()[action.type] as (action: VimAction, panel: HTMLElement) => void
    handle(action, panel ?? document.body)
  }

  private contextFor(target: EventTarget | null, panel: HTMLElement | null): KeyContext {
    const typing = this.api.app.isTyping(target)
    return {
      enabled: vimActive(),
      typing,
      passthrough: this.api.panels.isPassthrough(target),
      terminal: false,
      overlay: this.api.panels.overlayOpen(),
      finding: !typing && panel !== null && this.api.panels.findOf(panel)?.isOpen() === true,
    }
  }

  readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented) {
      return
    }
    const panel = this.activePanel()
    const result =
      this.terminalRead?.event === e
        ? this.terminalRead.result
        : readKey(e, this.contextFor(e.target, panel), this.pending, e.timeStamp)
    this.pending = result.pending
    if (!result.handled) {
      return
    }
    e.preventDefault()
    if (result.action !== null) {
      this.run(result.action, panel)
    }
  }

  /** Whether Vim mode takes this Esc, so other Esc handlers, such as stopping an agent, skip it. */
  readonly takesEscape = (e: KeyboardEvent): boolean => {
    if (e.key !== 'Escape' || !vimActive()) {
      return false
    }
    return readKey(e, this.contextFor(e.target, this.activePanel()), null, e.timeStamp).handled
  }

  /** Whether a terminal key is Vim mode's, as Ctrl+\ then n is; it then reaches onKeyDown. */
  readonly takesTerminalKey = (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown' || !vimActive()) {
      return false
    }
    if (this.terminalRead?.event !== e) {
      const context = { ...this.contextFor(e.target, null), terminal: true }
      const result = readKey(e, context, this.pending, e.timeStamp)
      this.terminalRead = { event: e, result }
      this.pending = result.pending
    }
    return this.terminalRead.result.handled
  }

  /** Enter in a chat's find field leaves it for the panel, so n and N step through matches. */
  readonly onFindEnter = (field: HTMLElement, e: { shiftKey: boolean }): boolean => {
    if (e.shiftKey || !vimActive()) {
      return false
    }
    this.enterNormalMode(field)
    return true
  }

  private readonly follow = (): void => {
    const focused = document.activeElement
    const panel = this.api.panels.panelOf(focused)
    if (panel !== null) {
      this.lastPanel = panel
    }
    const typing = this.api.app.isTyping(focused) || this.api.panels.isPassthrough(focused)
    setVimMode(typing ? 'insert' : 'normal')
    this.api.panels.markActive(this.activePanel())
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    const panel = this.api.panels.panelOf(e.target instanceof Element ? e.target : null)
    if (panel !== null) {
      this.lastPanel = panel
      this.api.panels.markActive(panel)
    }
  }

  /** Turns the keys on, following focus and marking the active panel; returns what stops them. */
  watch(): Disposer {
    setVimActive(true)
    this.follow()
    document.addEventListener('focusin', this.follow)
    document.addEventListener('focusout', this.follow)
    document.addEventListener('pointerdown', this.onPointerDown, true)
    return () => {
      document.removeEventListener('focusin', this.follow)
      document.removeEventListener('focusout', this.follow)
      document.removeEventListener('pointerdown', this.onPointerDown, true)
      setVimActive(false)
      setVimHelpOpen(false)
      this.pending = null
      this.terminalRead = null
      this.api.panels.markActive(null)
    }
  }
}
