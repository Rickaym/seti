import {
  negotiateProtocol,
  type JournalCursor,
  type NodeMessage,
  type NodeMessageOf,
  type ProtocolRange,
} from '@seti/shared'
import type { CloseReason, LinkConnection } from './connection.js'
import type { LinkSession } from './link.js'

const DEFAULT_HANDSHAKE_MS = 10_000
const INCOMPATIBLE = 'incompatible'

/** The versions and features this side speaks. */
export interface LocalProtocol {
  protocol: ProtocolRange
  features: string[]
}

type FirstMessage = { kind: 'message'; message: NodeMessage } | { kind: 'closed'; reason: string }

const describe = (reason: CloseReason): string => {
  switch (reason.kind) {
    case 'ended':
      return 'the connection ended'
    case 'local':
      return reason.reason
    case 'frame':
      return reason.error.message
    case 'invalid':
      return reason.error
    case 'error':
      return reason.message
  }
}

/** The first message on `connection`; later ones stay held for the link. */
async function firstMessage(connection: LinkConnection, timeoutMs: number): Promise<FirstMessage> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      connection.listen(null)
      connection.close('no handshake in time')
      resolve({ kind: 'closed', reason: 'no handshake in time' })
    }, timeoutMs)
    const done = (result: FirstMessage) => {
      clearTimeout(timer)
      connection.listen(null)
      resolve(result)
    }
    connection.listen({
      message: (message) => {
        done({ kind: 'message', message })
      },
      close: (reason) => {
        done({ kind: 'closed', reason: describe(reason) })
      },
    })
  })
}

/** How the node's hello went. */
export type NodeGreeting =
  { kind: 'welcomed'; session: LinkSession } | { kind: 'incompatible' } | { kind: 'failed'; reason: string }

export interface NodeHelloOptions {
  local: LocalProtocol
  node: string
  boot: string
  sessions: Record<string, unknown>
  timeoutMs?: number
}

/** The node's side: say hello and wait for the welcome. */
export async function greetControlPlane(connection: LinkConnection, options: NodeHelloOptions): Promise<NodeGreeting> {
  const { local, node, boot, sessions } = options
  connection.useVersion(local.protocol.max)
  connection.send({
    type: 'hello',
    node,
    boot,
    protocol: local.protocol,
    features: local.features,
    clock: Date.now(),
    sessions,
  })
  const first = await firstMessage(connection, options.timeoutMs ?? DEFAULT_HANDSHAKE_MS)
  if (first.kind === 'closed') {
    return { kind: 'failed', reason: first.reason }
  }
  const { message } = first
  if (message.type === 'bye' && message.reason === INCOMPATIBLE) {
    return { kind: 'incompatible' }
  }
  if (message.type !== 'welcome') {
    connection.close(`expected a welcome, got ${message.type}`)
    return { kind: 'failed', reason: `expected a welcome, got ${message.type}` }
  }
  if (message.version < local.protocol.min || message.version > local.protocol.max) {
    connection.close('welcome chose a version this node does not speak')
    return { kind: 'failed', reason: 'welcome chose a version this node does not speak' }
  }
  const features = message.features.filter((name) => local.features.includes(name))
  return { kind: 'welcomed', session: { version: message.version, features, cursors: message.cursors } }
}

/** How a node's hello went on the control plane. */
export type ControlGreeting =
  | { kind: 'accepted'; hello: NodeMessageOf<'hello'>; session: LinkSession }
  | { kind: 'incompatible'; hello: NodeMessageOf<'hello'> }
  | { kind: 'failed'; reason: string }

export interface WelcomeOptions {
  local: LocalProtocol
  /** The journal cursors to send to the node that said hello. */
  cursorsFor: (hello: NodeMessageOf<'hello'>) => Promise<Record<string, JournalCursor>>
  timeoutMs?: number
}

/** The control plane's side: wait for hello, pick a version and welcome the node. */
export async function welcomeNode(connection: LinkConnection, options: WelcomeOptions): Promise<ControlGreeting> {
  const { local } = options
  connection.useVersion(local.protocol.max)
  const first = await firstMessage(connection, options.timeoutMs ?? DEFAULT_HANDSHAKE_MS)
  if (first.kind === 'closed') {
    return { kind: 'failed', reason: first.reason }
  }
  const hello = first.message
  if (hello.type !== 'hello') {
    connection.close(`expected a hello, got ${hello.type}`)
    return { kind: 'failed', reason: `expected a hello, got ${hello.type}` }
  }
  const agreement = negotiateProtocol(local, hello)
  if (agreement.kind === 'incompatible') {
    connection.close(INCOMPATIBLE)
    return { kind: 'incompatible', hello }
  }
  const cursors = await options.cursorsFor(hello)
  connection.useVersion(agreement.version)
  connection.send({ type: 'welcome', version: agreement.version, features: agreement.features, cursors })
  return { kind: 'accepted', hello, session: { version: agreement.version, features: agreement.features } }
}
