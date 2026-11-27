import type { AccessKind, AgentCapabilities } from '@seti/shared'
import type { ReactNode } from 'react'
import { NotOnRuntime } from '@/panels/tasks/NotOnRuntime'

/** The kinds of access the agent's runtime cannot use, each with what to show in its place. */
export function unavailableKinds(caps: AgentCapabilities | null): Partial<Record<AccessKind, ReactNode>> {
  if (caps === null) {
    return {}
  }
  const { label } = caps
  return {
    ...(caps.mcp_servers
      ? {}
      : {
          mcp: (
            <NotOnRuntime
              label={label}
              reason={`${label} agents load none of your MCP servers; only Seti's own tools reach them.`}
            />
          ),
        }),
    ...(caps.plugins ? {} : { plugin: <NotOnRuntime label={label} reason={`${label} agents load no plugins.`} /> }),
  }
}
