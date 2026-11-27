import type { ToolCall } from '@seti/shared'
import type { RelayedServer } from './tool-relay.js'

/** Seti's verdict on one call: run it, or refuse it with the reason the agent reads. */
type RelayVerdict = { allow: true } | { allow: false; message: string }

/** Seti's decision on one call, until the signal aborts because the call was cancelled. */
export type RelayDecide = (call: ToolCall, signal: AbortSignal) => Promise<RelayVerdict>

/** A tool server call as Seti decides it: the input is the arguments the relay received. */
const relayedCall = (server: string, tool: string, args: Record<string, unknown>, id: string): ToolCall => ({
  callId: id,
  kind: 'mcp',
  name: `mcp__${server}__${tool}`,
  input: args,
  mcp: { server, tool },
})

const refusal = (message: string) => ({ content: [{ type: 'text', text: message }], isError: true })

/**
 * The servers with Seti's decision taken in the relay, on the exact arguments each call runs
 * with, before the call reaches the server. For a runtime whose permission request shows only a
 * title, so the request alone could never be decided on what will run.
 */
export function gatedServers(servers: readonly RelayedServer[], decide: RelayDecide): RelayedServer[] {
  let calls = 0
  return servers.map((server) => ({
    ...server,
    call: async (tool, args, signal) => {
      calls += 1
      const call = relayedCall(server.name, tool, args, `relay-${String(calls)}`)
      const verdict = await decide(call, signal).catch((e: unknown) => ({
        allow: false as const,
        message: `Seti could not decide this call: ${e instanceof Error ? e.message : String(e)}`,
      }))
      if (signal.aborted) {
        return refusal('The call was cancelled before Seti decided it.')
      }
      return verdict.allow ? server.call(tool, args, signal) : refusal(verdict.message)
    },
  }))
}
