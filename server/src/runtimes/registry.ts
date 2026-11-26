import type { RuntimeId, RuntimeSession, SessionHost } from './adapter.js'
import { claudeAdapter } from './claude/adapter.js'
import type { ClaudeShapes } from './claude/session.js'
import { codexAdapter } from './codex/adapter.js'
import { geminiAdapter } from './gemini/adapter.js'

export { loadSdkModule } from './claude/adapter.js'

const ADAPTERS = { claude: claudeAdapter, codex: codexAdapter, gemini: geminiAdapter } satisfies {
  [Id in RuntimeId]: { id: Id }
}

type Adapters = typeof ADAPTERS

/** The runtime every agent runs on until an agent can name its own. */
export const DEFAULT_RUNTIME = 'claude' satisfies RuntimeId

/** The runtime-shaped values of the default runtime's sessions. */
export type DefaultShapes = ClaudeShapes

/** An open session of the default runtime. */
export type DefaultSession = RuntimeSession<DefaultShapes>

/** What Seti answers for a session of the default runtime. */
export type DefaultHost = SessionHost<DefaultShapes>

/** The adapter that drives the runtime. */
export const adapterFor = <Id extends RuntimeId>(id: Id): Adapters[Id] => ADAPTERS[id]
