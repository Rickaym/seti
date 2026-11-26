import path from 'node:path'
import type { Task, ToolCall } from '@seti/shared'
import { nodeLink } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'
import type { SessionHost } from './runtimes/adapter.js'
import type { CodexDecide } from './runtimes/codex/approvals.js'
import type { CodexShapes } from './runtimes/codex/session.js'
import { SANDBOX_RUN } from './sandbox-mounts.js'
import { openToolRelay, type RelayedServer } from './tool-relay.js'

/** Asks the control plane for Seti's answer to each call; the user may take as long as they like. */
export const decideByAsking =
  (taskId: string, session: AbortSignal): CodexDecide =>
  async (call: ToolCall, signal: AbortSignal) =>
    nodeLink.ask(taskId, 'call.decide', { call }, AbortSignal.any([signal, session]))

/** Each of the agent's tool servers, whose calls run on the control plane as the agent. */
export function relayed(taskId: string, servers: { name: string; tools: RelayedServer['tools'] }[]): RelayedServer[] {
  return servers.map(({ name, tools }) => ({
    name,
    tools,
    call: async (tool, args, signal) =>
      (await nodeLink.ask(taskId, 'tool.call', { server: name, tool, args }, signal)).result,
  }))
}

/**
 * What Seti answers for a Codex agent's session until it ends: every call it asks about goes to
 * the control plane, and Seti's own tools reach it through the relay in its sandbox's run folder.
 */
export async function codexHost(task: Task, session: AbortSignal): Promise<SessionHost<CodexShapes>> {
  const { servers } = await nodeLink.ask(task.id, 'tools.list', {})
  const place = { dir: path.join(sandboxDirOf(task.id), 'run'), seenAs: SANDBOX_RUN }
  // The control plane listed them with an MCP client of the server itself.
  const listed = servers as { name: string; tools: RelayedServer['tools'] }[]
  const toolServers = await openToolRelay(place, relayed(task.id, listed), session)
  return { decide: decideByAsking(task.id, session), hooks: null, toolServers }
}
