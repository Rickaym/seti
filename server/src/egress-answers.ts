import { ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

/** Where a CONNECT goes. */
export interface Target {
  host: string
  port: number
}

export function parseAuthority(authority: string): Target | null {
  const match = /^\[?([^\]\s]+?)\]?:(\d{1,5})$/.exec(authority)
  const port = Number(match?.[2])
  if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return null
  }
  return { host: match[1].toLowerCase().replace(/\.$/, ''), port }
}

export function answer(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export const NO_CLAUDE_CREDENTIAL = JSON.stringify({
  type: 'error',
  error: {
    type: 'authentication_error',
    message: 'Seti has no Claude credential for sandboxed agents: log in with claude on the host or set a token.',
  },
})

export const connectorOff = (id: string) =>
  JSON.stringify({ error: `Seti: the MCP server ${id} is turned off for this agent. Ask the user to turn it on.` })

export function refuseSocket(socket: Duplex, status: number, reason: string, body: string): void {
  const length = String(Buffer.byteLength(body))
  socket.end(
    `HTTP/1.1 ${String(status)} ${reason}\r\ncontent-type: text/plain\r\nconnection: close\r\n` +
      `content-length: ${length}\r\n\r\n${body}`,
  )
}

/** The control plane did not hand over a value in time, as while it restarts; clients retry a 503. */
export class ValueLate extends Error {
  constructor() {
    super("Seti sandbox proxy: Seti's control plane did not hand over a credential in time. Retry in a moment.")
  }
}

/** An unreadable value counts as none, unless it is late: then the request waits no more. */
export const noValue = (e: unknown): null => {
  if (e instanceof ValueLate) {
    throw e
  }
  return null
}

/** Runs a request or a WebSocket handshake; one whose value came too late gets a 503 to retry. */
export async function answerLate(to: ServerResponse | Duplex, run: () => Promise<void>): Promise<void> {
  await run().catch((e: unknown) => {
    if (!(e instanceof ValueLate)) {
      throw e
    }
    if (to instanceof ServerResponse) {
      answer(to, 503, e.message)
    } else {
      refuseSocket(to, 503, 'Service Unavailable', e.message)
    }
  })
}

/** Why a host was refused, in the words a command's error output shows the agent. */
export const refusalText = (host: string) =>
  `Seti sandbox: ${host} is not on the allowed hosts list. Ask the user to add it in Settings, Sandbox.`
