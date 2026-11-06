import type { ModAgentsLayout } from '@seti/mod-api'
import { LayoutGrid } from 'lucide-react'
import { AgentGrid } from './AgentGrid'
import type { Panel } from './grid-layout'
import { gridStore, isInGrid } from './grid-store'
import { seti } from './seti'
import { addTerminalTile, holdsTerminal, terminalToGrid } from './tiles'

let shown: { panels: readonly Panel[]; agents: string[] } = { panels: [], agents: [] }

/** The grid's agents, the same array until its panels change. */
function gridAgents(): string[] {
  const { panels } = gridStore.getSnapshot()
  if (panels !== shown.panels) {
    shown = { panels, agents: panels.flatMap((panel) => (panel.agent === null ? [] : [panel.agent])) }
  }
  return shown.agents
}

/** The grid as the Agents section's layout: on per device, one layout per workspace. */
export function gridLayout(): ModAgentsLayout {
  const keys = seti().keys.label('Alt+G')
  return {
    id: 'grid',
    icon: LayoutGrid,
    active: { get: () => gridStore.getSnapshot().enabled, subscribe: gridStore.subscribe },
    setActive: gridStore.setEnabled,
    hint: (on) => (on ? `Back to one agent (${keys})` : `Show agents side by side in a grid (${keys})`),
    view: { view: AgentGrid },
    shows: ({ id, terminal, listed, loaded }) =>
      terminal === null ? id === null || listed || !loaded || isInGrid(id) : holdsTerminal(terminal),
    subscribe: gridStore.subscribe,
    shownAgents: gridAgents,
    acceptsAgents: true,
    overlay: true,
    adoptTerminal: terminalToGrid,
    newTerminal: addTerminalTile,
    showWorkspace: ({ id, first }) => {
      gridStore.showWorkspace(id, first)
    },
  }
}
