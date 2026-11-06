import { defineMod } from '@seti/mod-api'
import { registerGridCommands } from './commands'
import { gridStore } from './grid-store'
import { gridLayout } from './layout'
import { setSeti } from './seti'
import manifest from './seti-mod.json' with { type: 'json' }
import { gridTerminalSource } from './tiles'

/** Agents and terminals side by side in panels, one layout per workspace. */
export const gridUi = defineMod({
  manifest,
  ui: (api) => {
    setSeti(api)
    api.registerAgentsLayout(gridLayout())
    api.registerTerminalSource(gridTerminalSource)
    registerGridCommands(api)
    api.onDispose(() => {
      gridStore.flush()
      setSeti(null)
    })
  },
})
