import type { ModCommandContext, UiModApi } from '@seti/mod-api'
import { Eraser, LayoutGrid, Lock, Move, Rows3 } from 'lucide-react'
import { clearGrid, lockGrid, tidyGrid } from './grid-actions'
import { onAgentsPage } from './grid-dom'
import { gridStore } from './grid-store'
import { seti } from './seti'

/** Arrange mode of the grid on screen, which only the mounted grid can start. */
export const arranger: { current: ((id: string) => void) | null } = { current: null }

/** The grid fills the Agents section here, which phones never show. */
const shown = ({ section, narrow }: ModCommandContext) =>
  !narrow && gridStore.getSnapshot().enabled && section === 'agents'

const arranged = (context: ModCommandContext) => shown(context) && gridStore.getSnapshot().panels.length > 0

/** Turns the grid on, or off when the Agents grid is already on screen. */
function toggleGrid(): void {
  const { enabled } = gridStore.getSnapshot()
  if (enabled && onAgentsPage()) {
    gridStore.setEnabled(false)
    return
  }
  gridStore.setEnabled(true)
  if (!onAgentsPage()) {
    seti().agents.open()
  }
}

/** The grid's commands: Alt+G and the palette, everywhere but on phones, and Open in grid. */
export function registerGridCommands(api: UiModApi): void {
  api.registerCommand({
    id: 'toggle',
    icon: LayoutGrid,
    when: ({ narrow }) => !narrow,
    title: (context) => (shown(context) ? 'Show one agent' : 'Agent grid'),
    run: toggleGrid,
  })
  api.registerCommand({
    id: 'open',
    icon: LayoutGrid,
    when: (context) => !context.narrow && context.agent !== null && !shown(context),
    run: () => {
      gridStore.setEnabled(true)
    },
  })
  api.registerCommand({ id: 'tidy', icon: Rows3, when: arranged, run: tidyGrid })
  api.registerCommand({
    id: 'lock',
    icon: Lock,
    when: shown,
    title: () => (gridStore.getSnapshot().locked ? 'Unlock grid layout' : 'Lock grid layout'),
    run: () => {
      lockGrid(!gridStore.getSnapshot().locked)
    },
  })
  api.registerCommand({ id: 'clear', icon: Eraser, when: arranged, run: clearGrid })
  api.registerCommand({
    id: 'arrange',
    icon: Move,
    when: (context) => {
      const { focused, locked } = gridStore.getSnapshot()
      return shown(context) && focused !== null && !locked && arranger.current !== null
    },
    run: () => {
      const { focused } = gridStore.getSnapshot()
      if (focused !== null) {
        arranger.current?.(focused)
      }
    },
  })
}
