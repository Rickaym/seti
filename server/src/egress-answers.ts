import type { ServerResponse } from 'node:http'
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
