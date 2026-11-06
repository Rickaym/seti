import { AGENT_SETUP_TOOLS } from './agent-setup.js'
import { AGENT_TOOLS } from './agents.js'
import { CHANNEL_TOOLS } from './channels.js'
import { CONTEXT_TOOLS } from './context.js'
import { HISTORY_TOOLS } from './history.js'
import { MOD_TOOLS } from './mods.js'
import { PLATFORM_TOOLS } from './platform.js'
import { PR_TOOLS } from './prs.js'
import { TEAM_TOOLS } from './team.js'
import type { SetiTool } from './tool.js'
import { WAIT_TOOLS } from './waits.js'
import { WORKSPACE_TOOLS } from './workspaces.js'

/** Every seti tool an agent at Seti control Full gets, mirroring the EA's Seti tools. */
export const SETI_TOOLS: readonly SetiTool[] = [
  ...AGENT_TOOLS,
  ...HISTORY_TOOLS,
  ...WAIT_TOOLS,
  ...AGENT_SETUP_TOOLS,
  ...TEAM_TOOLS,
  ...PR_TOOLS,
  ...CONTEXT_TOOLS,
  ...PLATFORM_TOOLS,
  ...CHANNEL_TOOLS,
  ...WORKSPACE_TOOLS,
  ...MOD_TOOLS,
]
