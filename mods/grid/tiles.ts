import type { ModTerminalSource, TerminalRef } from '@seti/mod-api'
import { useEffect, useSyncExternalStore } from 'react'
import { announce, focusInto, onAgentsPage, revealPanel, showInAddress } from './grid-dom'
import type { Panel } from './grid-layout'
import { gridStore } from './grid-store'
import { seti } from './seti'

const FULL = 'Seti holds 16 terminals outside the grid at most; close one to open another'

const panelOf = (id: string): Panel | undefined => gridStore.getSnapshot().panels.find((panel) => panel.i === id)

const tileOf = (terminalId: string): Panel | undefined =>
  gridStore.getSnapshot().panels.find((panel) => panel.terminal?.id === terminalId)

/** A new shell in the home folder, named apart from the other terminals. */
const newTerminal = (): TerminalRef => seti().terminals.mint(seti().terminals.HOME)

function focusTile(id: string, done: string): void {
  gridStore.focus(id)
  showInAddress(null)
  announce(`${panelOf(id)?.terminal?.name ?? seti().terminals.HOME.name} ${done}`)
  requestAnimationFrame(() => {
    revealPanel(id)
    focusInto(id)
  })
}

/** Adds a tile with a new shell to the grid. */
export function addTerminalTile(): void {
  focusTile(gridStore.openTerminal(newTerminal()), 'added to the grid')
}

/** Shows a terminal in empty panel `id`: one from outside the grid, or a new shell. */
export function terminalInPanel(id: string, existing?: TerminalRef): void {
  const terminal = existing ?? newTerminal()
  seti().terminals.release(terminal.id)
  gridStore.setTerminal(id, terminal)
  focusTile(id, 'opened in the panel')
}

/** Takes the tile out of the grid and ends its shell. */
export function closeTile(id: string): void {
  const terminal = panelOf(id)?.terminal
  gridStore.remove(id)
  if (terminal !== undefined) {
    void seti().terminals.stop(terminal.id)
  }
}

/** Takes the tile out of the grid; its shell keeps running and the terminal list keeps it. */
export function removeTile(id: string): void {
  const terminal = panelOf(id)?.terminal
  if (terminal === undefined) {
    return
  }
  if (!seti().terminals.adopt(terminal)) {
    seti().kit.fail(FULL)
    return
  }
  gridStore.remove(id)
  const { focused, panels } = gridStore.getSnapshot()
  showInAddress(panels.find((panel) => panel.i === focused)?.agent ?? null)
  announce(`Removed ${terminal.name} from the grid`)
}

/** Leaves the grid and shows the tile's terminal alone. */
export function tileAlone(id: string): void {
  const terminal = panelOf(id)?.terminal
  if (terminal !== undefined) {
    gridStore.setEnabled(false)
    seti().terminals.openAlone(terminal.id)
  }
}

/** Moves a terminal into the grid; its shell keeps running. */
export function terminalToGrid(terminal: TerminalRef): void {
  seti().terminals.release(terminal.id)
  const id = gridStore.openTerminal(terminal)
  if (!onAgentsPage()) {
    seti().agents.open()
  }
  focusTile(id, 'moved to the grid')
}

let tiles: { panels: readonly Panel[]; terminals: TerminalRef[] } = { panels: [], terminals: [] }

/** The grid's terminal tiles, the same array until the panels change. */
function gridTerminals(): TerminalRef[] {
  const { panels } = gridStore.getSnapshot()
  if (panels !== tiles.panels) {
    tiles = { panels, terminals: panels.flatMap((panel) => (panel.terminal === undefined ? [] : [panel.terminal])) }
  }
  return tiles.terminals
}

/** The grid's tiles, which phones list too, since they show no grid. */
export const gridTerminalSource: ModTerminalSource = {
  id: 'tiles',
  label: 'in grid',
  list: gridTerminals,
  subscribe: gridStore.subscribe,
  refresh: gridStore.refresh,
  close: (id) => {
    const tile = tileOf(id)
    if (tile !== undefined) {
      closeTile(tile.i)
    }
  },
  rename: (id, name) => {
    const tile = tileOf(id)
    if (tile !== undefined) {
      gridStore.renameTerminal(tile.i, name)
    }
  },
}

/** True while the grid holds terminal `id`. */
export const holdsTerminal = (id: string): boolean => tileOf(id) !== undefined

/** Focuses the tile of terminal `id` while the address names it, as the grid does for an agent. */
export function useRoutedTile(id: string | null): void {
  const tile = useSyncExternalStore(gridStore.subscribe, () => (id === null ? undefined : tileOf(id)?.i))
  useEffect(() => {
    if (tile !== undefined) {
      focusTile(tile, 'focused')
    }
  }, [tile])
}
