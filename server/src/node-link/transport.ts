import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { NodeMessageOf } from '@seti/shared'
import { LinkConnection } from './connection.js'
import type { LinkEventSink } from './events.js'
import { greetControlPlane, welcomeNode, type LocalProtocol, type WelcomeOptions } from './handshake.js'
import type { LinkPeer } from './link.js'

export interface BackoffOptions {
  minMs?: number
  maxMs?: number
  random?: () => number
}

/** The wait before reconnect attempt `attempt`: doubling from 1 s to 30 s, give or take a quarter. */
export function backoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const min = options.minMs ?? 1_000
  const max = options.maxMs ?? 30_000
  const random = options.random ?? Math.random
  const ceiling = Math.min(max, min * 2 ** Math.min(attempt, 30))
  return Math.min(max, Math.max(min, ceiling * (0.75 + 0.5 * random())))
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code

async function connectSocket(file: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(file)
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

/** Refuses a socket path whose folder others can write, or that is a link or someone else's. */
async function checkSocketPath(file: string): Promise<void> {
  const uid = process.getuid?.()
  const folder = await fs.lstat(path.dirname(file))
  if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o022) !== 0) {
    throw new Error(`refusing ${path.dirname(file)}: it must be a folder only its owner can write`)
  }
  let existing
  try {
    existing = await fs.lstat(file)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return
    }
    throw error
  }
  if (existing.isSymbolicLink() || existing.uid !== uid || !existing.isSocket()) {
    throw new Error(`refusing ${file}: it is a link, not a socket, or not owned by this user`)
  }
  const live = await connectSocket(file).then(
    (socket) => {
      socket.destroy()
      return true
    },
    () => false,
  )
  if (live) {
    throw new Error(`refusing ${file}: another process is listening on it`)
  }
}

export interface NodeServerOptions extends WelcomeOptions {
  /** The socket path; its folder must be writable only by this user. */
  path: string
  /** The peer for the node that said hello; the same node should get the same peer each time. */
  peerFor: (hello: NodeMessageOf<'hello'>) => LinkPeer
  maxFrameBytes?: number
  onEvent?: LinkEventSink
}

export interface NodeServer {
  close(): Promise<void>
}

async function serveNode(socket: net.Socket, options: NodeServerOptions): Promise<void> {
  const connection = new LinkConnection(socket, {
    version: options.local.protocol.max,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  })
  const greeting = await welcomeNode(connection, options).catch(() => {
    connection.close('could not welcome the node')
    return null
  })
  if (greeting?.kind === 'incompatible') {
    options.onEvent?.({ type: 'incompatible', node: greeting.hello.node })
  }
  if (greeting?.kind !== 'accepted') {
    return
  }
  options.onEvent?.({ type: 'connected', node: greeting.hello.node, version: greeting.session.version })
  await options.peerFor(greeting.hello).attach(connection, greeting.session)
}

/** The control plane's listener: a unix socket with mode 0600 that nodes dial. */
export async function listenForNodes(options: NodeServerOptions): Promise<NodeServer> {
  await checkSocketPath(options.path)
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    void serveNode(socket, options)
  })
  const staging = path.join(path.dirname(options.path), `.${randomBytes(6).toString('hex')}.sock`)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(staging, () => {
      server.off('error', reject)
      resolve()
    })
  })
  await fs.chmod(staging, 0o600)
  await fs.rename(staging, options.path)
  return {
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve))
      for (const socket of sockets) {
        socket.destroy()
      }
      await closed
      await fs.unlink(options.path).catch((error: unknown) => {
        if (errorCode(error) !== 'ENOENT') {
          throw error
        }
      })
    },
  }
}

export interface DialOptions {
  /** The control plane's socket path. */
  path: string
  local: LocalProtocol
  node: string
  /** An id made at each start of the node process. */
  boot: string
  /** The sessions this node runs, sent with every hello. */
  sessions: () => Record<string, unknown>
  peer: LinkPeer
  backoff?: BackoffOptions
  maxFrameBytes?: number
  onEvent?: LinkEventSink
}

export interface NodeDialer {
  stop(): Promise<void>
}

/** One connection from dial to close; true when it got as far as the welcome. */
async function connectOnce(options: DialOptions, track: (connection: LinkConnection) => void): Promise<boolean> {
  const socket = await connectSocket(options.path)
  const connection = new LinkConnection(socket, {
    version: options.local.protocol.max,
    ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
  })
  track(connection)
  const { local, node, boot } = options
  const greeting = await greetControlPlane(connection, { local, node, boot, sessions: options.sessions() })
  if (greeting.kind === 'incompatible') {
    options.onEvent?.({ type: 'incompatible', node })
  }
  if (greeting.kind !== 'welcomed') {
    connection.close('handshake failed')
    return false
  }
  options.onEvent?.({ type: 'connected', node, version: greeting.session.version })
  await options.peer.attach(connection, greeting.session)
  return true
}

/** The node's side: dials the control plane and dials again with backoff whenever it drops. */
export function dialControlPlane(options: DialOptions): NodeDialer {
  const abort = new AbortController()
  let current: LinkConnection | null = null
  const track = (connection: LinkConnection) => {
    current = connection
    if (abort.signal.aborted) {
      connection.close('node stopping')
    }
  }
  const loop = async () => {
    let attempt = 0
    while (!abort.signal.aborted) {
      const welcomed = await connectOnce(options, track).catch(() => false)
      attempt = welcomed ? 0 : attempt + 1
      await delay(backoffDelay(attempt, options.backoff), undefined, { signal: abort.signal }).catch(() => undefined)
    }
  }
  const running = loop()
  return {
    stop: async () => {
      abort.abort()
      current?.close('node stopping')
      await running
    },
  }
}
