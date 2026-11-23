import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { NodeAnswer, Task } from '@seti/shared'
import { inProcessServer, type HostTool } from './runtimes/claude/tool-server.js'

/**
 * Builds the tools Seti serves a task's session itself, keyed by MCP server name.
 * @public
 */
export type SessionMcpServers = (task: Task) => Record<string, readonly HostTool[]>

const factories: SessionMcpServers[] = []

/** @public */
export function registerSessionMcpServers(factory: SessionMcpServers): void {
  factories.push(factory)
}

/** How long one tool call may run; the agent's runtime cancels a call it stops waiting for. */
const CALL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000

/** Each task's tool servers as its process was handed them, with a client that calls them. */
const served = new Map<string, Map<string, Client>>()

/** Serves the tools as an MCP server in this process and connects a client to it. */
async function connect(name: string, tools: readonly HostTool[]): Promise<Client> {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair()
  await inProcessServer(name, tools).instance.connect(serverEnd)
  const client = new Client({ name: 'seti-node-link', version: '1.0.0' })
  await client.connect(clientEnd)
  return client
}

/** Closes the task's tool servers, as its process ended. */
export function forgetSessionTools(taskId: string): void {
  for (const client of served.get(taskId)?.values() ?? []) {
    void client.close()
  }
  served.delete(taskId)
}

/** The tools the task's process gets, by server, as the MCP servers list them. */
export async function listSessionTools(task: Task): Promise<NodeAnswer<'tools.list'>> {
  forgetSessionTools(task.id)
  const clients = new Map<string, Client>()
  served.set(task.id, clients)
  const servers: NodeAnswer<'tools.list'>['servers'] = []
  for (const factory of factories) {
    for (const [name, tools] of Object.entries(factory(task))) {
      const client = await connect(name, tools)
      clients.set(name, client)
      servers.push({ name, tools: (await client.listTools()).tools })
    }
  }
  return { servers }
}

/** Runs a tool of the task's process as the agent; a server it was never handed is refused. */
export async function callSessionTool(
  taskId: string,
  call: { server: string; tool: string; args: Record<string, unknown> },
  signal: AbortSignal,
): Promise<NodeAnswer<'tool.call'>> {
  const client = served.get(taskId)?.get(call.server)
  if (client === undefined) {
    throw new Error(`The ${call.server} MCP server is not open for this agent; it opens with its next session.`)
  }
  const options = { signal, timeout: CALL_TIMEOUT_MS }
  return { result: await client.callTool({ name: call.tool, arguments: call.args }, undefined, options) }
}
