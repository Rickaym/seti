import { inProcessDecisions } from './session-decisions.js'
import { createSessionHost } from './session-host/host.js'
import type { SessionCommands } from './session-host/port.js'
import { createControlPort } from './session-ingest.js'

/** The session host that runs each task's Claude Code process, here in Seti's own process. */
export const sessionHost: SessionCommands = createSessionHost(
  createControlPort(() => sessionHost),
  inProcessDecisions,
)
