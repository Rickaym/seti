import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  McpServerStatus,
  Options,
  PermissionMode,
  Query,
} from '@anthropic-ai/claude-agent-sdk'
import type { RuntimeSession, ToolServerState } from '../adapter.js'
import type { ClaudeVendor } from './realise.js'
import { claudeReports } from './reports.js'

/** How long reading the context window may take before a compaction is stored without it. */
const CONTEXT_WAIT_MS = 3000

/** The rules Claude Code evaluates itself, as its settings name them. */
interface ClaudePolicy {
  allow: string[]
  ask: string[]
  deny: string[]
}

/** Claude Code's own shapes: plugins, SDK options, hooks, rules and permission modes. */
export interface ClaudeShapes {
  vendor: ClaudeVendor
  realised: Options
  decide: CanUseTool
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>
  hostServers: Record<string, McpServerConfig>
  policy: ClaudePolicy
  mode: PermissionMode
}

/** An MCP server's status without its configuration; a server configured without a type is stdio. */
const serverState = (s: McpServerStatus): ToolServerState => ({
  name: s.name,
  status: s.status,
  ...(s.error === undefined ? {} : { error: s.error }),
  transport: s.config?.type ?? (s.config === undefined ? null : 'stdio'),
})

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
    ...(typeof query.applyFlagSettings === 'function'
      ? { setPolicy: async (permissions: ClaudePolicy) => query.applyFlagSettings({ permissions: { ...permissions } }) }
      : {}),
  }
}

/** A Claude Code process the SDK started, as a runtime session; `rewound` when at a rewind point. */
export function claudeSession(query: Query, rewound: boolean): RuntimeSession<ClaudeShapes> {
  let closed = false
  const window = async () =>
    closed || typeof query.getContextUsage !== 'function' ? Promise.resolve(null) : contextWindowOf(query)
  return {
    events: claudeReports(query, rewound, window),
    interrupt: async () => {
      await query.interrupt()
    },
    close: () => {
      closed = true
      query.close()
    },
    stopBackground: async (jobId) => query.stopTask(jobId),
    toolServers: async () => (await query.mcpServerStatus()).map(serverState),
    setMode: async (mode) => query.setPermissionMode(mode),
    ...optionalControls(query),
  }
}
