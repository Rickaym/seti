import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { duplexPair } from 'node:stream'
import type { JournalCursor } from '@seti/shared'
import { LinkConnection, type CloseReason } from './connection.js'
import { greetControlPlane, welcomeNode, type LocalProtocol } from './handshake.js'
import type { LinkPeer } from './link.js'

export const LOCAL: LocalProtocol = { protocol: { min: 1, max: 1 }, features: ['bulk'] }

/** A folder under the system temp folder for one test. */
export async function scratchDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export interface Linked {
  /** Cuts the connection as a crash would, without a bye. */
  drop: () => void
  nodeClosed: Promise<CloseReason>
  controlClosed: Promise<CloseReason>
}

/** Connects two peers over an in-memory stream through the real handshake. */
export async function linkPeers(
  node: LinkPeer,
  control: LinkPeer,
  cursors: () => Promise<Record<string, JournalCursor>> = async () => Promise.resolve({}),
): Promise<Linked> {
  const [nodeSide, controlSide] = duplexPair()
  const nodeConnection = new LinkConnection(nodeSide, { version: 1 })
  const controlConnection = new LinkConnection(controlSide, { version: 1 })
  const [greeting, welcome] = await Promise.all([
    greetControlPlane(nodeConnection, { local: LOCAL, node: 'node-a', boot: 'boot-1', sessions: {} }),
    welcomeNode(controlConnection, { local: LOCAL, cursorsFor: cursors }),
  ])
  if (greeting.kind !== 'welcomed' || welcome.kind !== 'accepted') {
    throw new Error('handshake failed')
  }
  return {
    drop: () => nodeSide.destroy(),
    nodeClosed: node.attach(nodeConnection, greeting.session),
    controlClosed: control.attach(controlConnection, welcome.session),
  }
}
