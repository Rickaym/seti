import { announce, showInAddress } from './grid-dom'
import { gridStore } from './grid-store'
import { seti } from './seti'

/** Empties the grid, with a toast that puts the panels back. */
export function clearGrid(): void {
  const before = gridStore.clear()
  if (before.panels.length === 0) {
    return
  }
  showInAddress(null)
  const count = before.panels.length
  seti().kit.toast(`Cleared ${String(count)} ${count === 1 ? 'panel' : 'panels'}`, {
    action: {
      label: 'Undo',
      onClick: () => {
        gridStore.restore(before)
      },
    },
  })
}

export function lockGrid(locked: boolean): void {
  gridStore.setLocked(locked)
  announce(locked ? 'Grid layout locked' : 'Grid layout unlocked')
}

const panelsWord = (count: number) => `${String(count)} ${count === 1 ? 'panel' : 'panels'}`

/** How Tidy lays panels out under a template, for screen readers. */
const fitText = (perScreen: number | null) =>
  perScreen === null ? 'to fit the window' : `up to ${String(perScreen)} to a screen`

export function tidyGrid(): void {
  gridStore.tidy()
  const { panels, perScreen } = gridStore.getSnapshot()
  announce(`Tidied ${panelsWord(panels.length)} ${fitText(perScreen)}`)
}

/** Sets the most panels one screen holds, null for all in one, and tidies the grid to it. */
export function setPerScreen(perScreen: number | null): void {
  gridStore.setPerScreen(perScreen)
  const holds = perScreen === null ? 'every panel in one screen' : `up to ${panelsWord(perScreen)} a screen`
  announce(`Grid holds ${holds}`)
}
