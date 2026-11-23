import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'

/** What a tool call answers, as an MCP tool result. */
type ToolAnswer = Awaited<ReturnType<Parameters<typeof tool>[3]>>

/** A tool Seti runs in its own process; its handler gets the call's abort signal, if any. */
export interface HostTool {
  name: string
  description: string
  input: z.ZodRawShape
  call: (args: unknown, signal: AbortSignal | undefined) => Promise<ToolAnswer>
}

/** The abort signal of an MCP call, which fires when Claude Code cancels it or the session closes. */
const signalOf = (extra: unknown): AbortSignal | undefined =>
  typeof extra === 'object' && extra !== null && 'signal' in extra && extra.signal instanceof AbortSignal
    ? extra.signal
    : undefined

/** Serves the tools to a Claude Code session as one MCP server inside Seti's process. */
export const inProcessServer = (name: string, tools: readonly HostTool[]): McpSdkServerConfigWithInstance =>
  createSdkMcpServer({
    name,
    version: '1.0.0',
    tools: tools.map((entry) =>
      tool(entry.name, entry.description, entry.input, async (args, extra: unknown) =>
        entry.call(args, signalOf(extra)),
      ),
    ),
  })
