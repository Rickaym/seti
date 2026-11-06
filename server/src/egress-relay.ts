import type http from 'node:http'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { refuseSocket, type Target } from './egress-answers.js'

function headLines(raw: readonly string[]): string {
  let text = ''
  for (let at = 0; at + 1 < raw.length; at += 2) {
    text += `${raw[at] ?? ''}: ${raw[at + 1] ?? ''}\r\n`
  }
  return text
}

async function readAll(res: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of res) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  }
  return Buffer.concat(chunks)
}

/** Sends a WebSocket handshake upstream, then relays bytes both ways once it switches protocols. */
export function relayUpgrade(host: string, socket: Duplex, head: Buffer, out: http.ClientRequest): void {
  out.on('upgrade', (res, upstream, upstreamHead) => {
    socket.write(`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}\r\n${headLines(res.rawHeaders)}\r\n`)
    if (upstreamHead.length > 0) {
      socket.write(upstreamHead)
    }
    if (head.length > 0) {
      upstream.write(head)
    }
    upstream.on('error', () => {
      socket.destroy()
    })
    socket.on('close', () => {
      upstream.destroy()
    })
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  out.on('response', (res) => {
    void readAll(res).then((body) => {
      const type = res.headers['content-type'] ?? 'text/plain'
      socket.write(
        `HTTP/1.1 ${String(res.statusCode ?? 502)} ${res.statusMessage ?? ''}\r\ncontent-type: ${type}\r\n` +
          `connection: close\r\ncontent-length: ${String(body.length)}\r\n\r\n`,
      )
      socket.end(body)
    })
  })
  out.on('error', (e) => {
    refuseSocket(socket, 502, 'Bad Gateway', `Seti sandbox proxy could not reach ${host}: ${e.message}`)
  })
  socket.on('close', () => {
    out.destroy()
  })
  out.end()
}

/** Pipes a CONNECT tunnel to its upstream byte for byte, unread. */
export function tunnel(host: string, address: Target | Error, socket: Duplex, head: Buffer): void {
  if (address instanceof Error) {
    refuseSocket(socket, 502, 'Bad Gateway', address.message)
    return
  }
  const upstream = net.connect(address.port, address.host)
  let connected = false
  upstream.once('connect', () => {
    connected = true
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) {
      upstream.write(head)
    }
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', (e) => {
    if (connected) {
      socket.destroy()
    } else {
      refuseSocket(socket, 502, 'Bad Gateway', `Seti sandbox proxy could not reach ${host}: ${e.message}`)
    }
  })
  socket.on('close', () => upstream.destroy())
}
