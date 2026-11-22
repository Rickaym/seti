import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  McpServerStatus,
  Options,
  PermissionMode,
  Query,
  query,
  SDKMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeSession } from '../adapter.js'
import type { ClaudeVendor } from './realise.js'

/** How long reading the context window may take before a compaction is stored without it. */
const CONTEXT_WAIT_MS = 3000

/** The rules Claude Code evaluates itself, as its settings name them. */
interface ClaudePolicy {
  allow: string[]
  ask: string[]
  deny: string[]
}

/** Claude Code's own shapes: plugins, SDK options and start arguments, messages, MCP reports. */
export interface ClaudeShapes {
  vendor: ClaudeVendor
  realised: Options
  decide: CanUseTool
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  hostServers: Record<string, McpServerConfig>
  start: Parameters<typeof query>[0]
  message: SDKMessage
  toolServer: McpServerStatus
  policy: ClaudePolicy
  mode: PermissionMode
}

/** The SDK sends cancel_async_message from this method, which its Query type does not declare. */
interface CancelsQueued {
  cancelAsyncMessage: (uuid: string) => Promise<unknown>
}

const cancelsQueued = (query: object): query is CancelsQueued =>
  'cancelAsyncMessage' in query && typeof query.cancelAsyncMessage === 'function'

/** Reads the context window, giving up after CONTEXT_WAIT_MS. */
async function contextWindowOf(query: Query): Promise<number | null> {
  const late = new Promise<null>((resolve) => {
    setTimeout(resolve, CONTEXT_WAIT_MS, null).unref()
  })
  const usage = query.getContextUsage({ detail: 'summary' }).then(
    (u) => u.rawMaxTokens,
    () => null,
  )
  return Promise.race([usage, late])
}

/** The controls an older SDK, or a stand-in for it, may lack. */
function optionalControls(query: Query): Partial<RuntimeSession<ClaudeShapes>> {
  return {
    ...(cancelsQueued(query) ? { retract: async (uuid) => (await query.cancelAsyncMessage(uuid)) === true } : {}),
    ...(typeof query.getContextUsage === 'function' ? { contextWindow: async () => contextWindowOf(query) } : {}),
    ...(typeof query.applyFlagSettings === 'function'
      ? { setPolicy: async (permissions: ClaudePolicy) => query.applyFlagSettings({ permissions: { ...permissions } }) }
      : {}),
  }
}

/** A Claude Code process the SDK started, as a runtime session. */
export const claudeSession = (query: Query): RuntimeSession<ClaudeShapes> => ({
  events: query,
  interrupt: async () => {
    await query.interrupt()
  },
  close: () => {
    query.close()
  },
  stopBackground: async (jobId) => query.stopTask(jobId),
  toolServers: async () => query.mcpServerStatus(),
  setMode: async (mode) => query.setPermissionMode(mode),
  ...optionalControls(query),
})
