import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'

type StatOf = (file: string) => Pick<fs.Stats, 'uid' | 'mode'>

/** Only the owner may enter the socket's folder, or connect to the socket. */
const OWNER_ONLY = 0o077

/**
 * Refuses a node socket that another user made or could reach. Only the owner can create a file
 * in a folder that is theirs alone, so the socket's owner is the process that listens on it.
 */
export function checkNodeSocket(socket: string, uid: number, stat: StatOf = fs.statSync): void {
  const dir = stat(path.dirname(socket))
  const file = stat(socket)
  if (dir.uid !== uid || (dir.mode & OWNER_ONLY) !== 0) {
    throw new Error(`The node's folder ${path.dirname(socket)} must belong to this user alone`)
  }
  if (file.uid !== uid) {
    throw new Error(`The node socket ${socket} belongs to another user`)
  }
  if ((file.mode & OWNER_ONLY) !== 0) {
    throw new Error(`Other users can reach the node socket ${socket}`)
  }
}

/**
 * Listens on the socket in a folder only this user may enter, clearing one a stopped node left,
 * and hands each control plane that connects to `attach`. Nothing but the WebSocket is served.
 */
export async function listenNode(socket: string, attach: (control: WebSocket) => void): Promise<http.Server> {
  const dir = path.dirname(socket)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  fs.rmSync(socket, { force: true })
  const server = http.createServer((_request, response) => {
    response.writeHead(426).end()
  })
  new WebSocketServer({ server }).on('connection', attach)
  await new Promise<void>((resolve) => {
    server.listen(socket, resolve)
  })
  fs.chmodSync(socket, 0o600)
  return server
}
