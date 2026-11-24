import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js'
import { findBinary } from './binaries.js'

/** An MCP server Seti serves an agent's runtime: the tools it lists and how a call runs. */
export interface RelayedServer {
  name: string
  tools: ListToolsResult['tools']
  /** Runs one tool and answers its MCP result; the signal fires when the runtime cancels. */
  call: (tool: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

/** A program the runtime starts as a stdio MCP server. */
export interface StdioServer {
  command: string
  args: string[]
}

/** Where the relay's sockets are made on this machine, and where the agent's runtime sees them. */
export interface RelayPlace {
  dir: string
  seenAs: string
}

/** One server's MCP session over one connection the runtime's relay program opened. */
async function serve(relayed: RelayedServer, socket: net.Socket): Promise<void> {
  const instance = new McpServer({ name: relayed.name, version: '1.0.0' }, { capabilities: { tools: {} } })
  // The tools are listed as the server itself listed them.
  const listed = { tools: relayed.tools } satisfies ListToolsResult
  instance.server.setRequestHandler(ListToolsRequestSchema, () => listed)
  instance.server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
    // The server answered with its own MCP result.
    return (await relayed.call(params.name, params.arguments ?? {}, signal)) as CallToolResult
  })
  socket.once('close', () => {
    void instance.close()
  })
  await instance.connect(new StdioServerTransport(socket, socket))
}

/** What the relay holds open until the session ends. */
interface Held {
  listeners: net.Server[]
  sockets: Set<net.Socket>
  signal: AbortSignal
}

/** Listens on a fresh socket only its owner can open; closed once the session ended. */
async function listen(file: string, relayed: RelayedServer, held: Held): Promise<void> {
  const open = held.sockets
  await fs.promises.rm(file, { force: true })
  const listener = net.createServer((socket) => {
    open.add(socket)
    socket.once('close', () => open.delete(socket))
    serve(relayed, socket).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(file, () => {
      listener.off('error', reject)
      resolve()
    })
  })
  await fs.promises.chmod(file, 0o600)
  held.listeners.push(listener)
  if (held.signal.aborted) {
    listener.close()
  }
}

/**
 * Serves each server on its own unix socket in the agent's run folder until the signal fires, and
 * answers the program the runtime starts for each: socat joining its stdio to that socket. The
 * socket is the agent's identity, so no token enters the sandbox; every call runs as Seti runs it
 * for any runtime, with the same checks.
 */
export async function openToolRelay(
  place: RelayPlace,
  servers: readonly RelayedServer[],
  signal: AbortSignal,
): Promise<Record<string, StdioServer>> {
  if (servers.length === 0 || signal.aborted) {
    return {}
  }
  const socat = findBinary('socat')
  await fs.promises.mkdir(place.dir, { recursive: true, mode: 0o700 })
  const held: Held = { listeners: [], sockets: new Set(), signal }
  signal.addEventListener(
    'abort',
    () => {
      held.listeners.forEach((listener) => listener.close())
      held.sockets.forEach((socket) => socket.destroy())
    },
    { once: true },
  )
  const sockets = servers.map((relayed, index) => ({ relayed, file: `tools-${String(index)}.sock` }))
  await Promise.all(sockets.map(async ({ relayed, file }) => listen(path.join(place.dir, file), relayed, held)))
  return Object.fromEntries(
    sockets.map(({ relayed, file }) => [
      relayed.name,
      { command: socat, args: ['STDIO', `UNIX-CONNECT:${path.posix.join(place.seenAs, file)}`] },
    ]),
  )
}
