import path from 'node:path'
import type { Task } from '@seti/shared'
import { decideByAsking, relayed } from './codex-host.js'
import { nodeLink } from './node-link.js'
import { sandboxDirOf } from './owned-dirs.js'
import { gatedServers } from './relay-gate.js'
import type { AcpShapes } from './runtimes/acp/session.js'
import type { SessionHost } from './runtimes/adapter.js'
import { SANDBOX_RUN } from './sandbox-mounts.js'
import { openToolRelay, type RelayedServer } from './tool-relay.js'

/**
 * What Seti answers for an ACP agent's session until it ends: every call it asks about goes to
 * the control plane, and Seti's own tools reach it through the relay, where each call is decided
 * on the arguments it runs with, since the agent's own request shows only a title.
 */
export async function acpHost(task: Task, session: AbortSignal): Promise<SessionHost<AcpShapes>> {
  const decide = decideByAsking(task.id, session)
  const { servers } = await nodeLink.ask(task.id, 'tools.list', {})
  const place = { dir: path.join(sandboxDirOf(task.id), 'run'), seenAs: SANDBOX_RUN }
  // The control plane listed them with an MCP client of the server itself.
  const listed = servers as { name: string; tools: RelayedServer['tools'] }[]
  const toolServers = await openToolRelay(place, gatedServers(relayed(task.id, listed), decide), session)
  return { decide, hooks: null, toolServers }
}
