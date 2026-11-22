import type { RuntimeId } from './adapter.js'
import { claudeAdapter } from './claude/adapter.js'

export { loadSdkModule } from './claude/adapter.js'

const ADAPTERS = { claude: claudeAdapter } satisfies { [Id in RuntimeId]: { id: Id } }

type Adapters = typeof ADAPTERS

/** The runtime every agent runs on until an agent can name its own. */
export const DEFAULT_RUNTIME = 'claude' satisfies RuntimeId

/** The adapter that drives the runtime. */
export const adapterFor = <Id extends RuntimeId>(id: Id): Adapters[Id] => ADAPTERS[id]
