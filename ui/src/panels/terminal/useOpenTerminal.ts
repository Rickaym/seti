import { useNarrow } from '@/hooks/useMedia'
import { useTasks } from '@/hooks/useTasks'
import { parseHash, type Route } from '@/lib/route'
import { activeLayout, type AgentsLayout } from '@/panels/tasks/agents-layouts'
import { placeFor } from './terminal-list'
import { openNewTerminal, openTerminalAlone, recentTerminal, refreshTerminalSources } from './terminal-sources'
import { terminalStore } from './terminal-store'

/** The layout filling the main area, when it takes new terminals as panels of its own. */
function layoutInView(route: Route, narrow: boolean): AgentsLayout | null {
  const layout = activeLayout(narrow)
  if (layout?.newTerminal === undefined || route.section !== 'agents' || route.id === 'new') {
    return null
  }
  const { terminal } = route
  const shows = terminal === null || layout.shows({ id: null, terminal, listed: false, loaded: true })
  return shows ? layout : null
}

/**
 * The terminal button's action: in a layout that takes terminals it adds one there; anywhere else
 * it shows the terminal used last alone, or a new one where you are. `fresh` always starts one.
 */
export function useOpenTerminal(): (fresh?: boolean) => Promise<void> {
  const narrow = useNarrow()
  const { tasks } = useTasks()
  return async (fresh = false) => {
    const route = parseHash()
    const layout = layoutInView(route, narrow)
    if (layout !== null) {
      layout.newTerminal?.()
      return
    }
    if (!fresh && terminalStore.getSnapshot().terminals.length === 0) {
      await refreshTerminalSources()
    }
    const recent = fresh ? null : recentTerminal()
    if (recent === null) {
      openNewTerminal(placeFor(route, tasks))
    } else if (route.terminal !== recent) {
      openTerminalAlone(recent)
    }
  }
}
