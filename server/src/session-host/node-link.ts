import { randomUUID } from 'node:crypto'
import { NodeJournal } from '../node-link/journal.js'
import { LinkPeer } from '../node-link/link.js'
import { dialControlPlane, type NodeDialer } from '../node-link/transport.js'
import type { SessionDecisions } from '../session-decisions.js'
import { unstartedFirsts } from '../unstarted.js'
import { createSessionHost, type SessionHost } from './host.js'
import { commandHandler } from './link-commands.js'
import { JournalWriter, linkControlPort } from './link-port.js'
import { NODE_LINK_PROTOCOL } from './link-protocol.js'

export interface NodeLinkOptions {
  /** The records side's socket. */
  socket: string
  /** Where each agent's journal is kept on this machine. */
  journalDir: string
  node: string
  /** The node's decisions, which reach the records side; built once the peer exists. */
  decisions: (peer: LinkPeer) => SessionDecisions
}

export interface NodeLink {
  host: SessionHost
  peer: LinkPeer
  journal: NodeJournal
  dialer: NodeDialer
}

/** What the node reports of every agent it has a journal for, at each hello. */
async function snapshot(journal: NodeJournal, host: SessionHost) {
  const views = host.views()
  const kept = unstartedFirsts()
  const agents = await journal.list()
  return Object.fromEntries(
    agents.map((agent) => [
      agent.agent,
      { view: views.get(agent.agent) ?? null, unstarted: kept[agent.agent] ?? null, seq: agent.lastSeq },
    ]),
  )
}

/** Runs sessions on this machine and dials the records side, resuming each journal it missed. */
export async function startNodeLink(options: NodeLinkOptions): Promise<NodeLink> {
  const journal = await NodeJournal.open(options.journalDir)
  const writer = new JournalWriter(journal)
  let host: SessionHost | null = null
  const peer = new LinkPeer({
    journal,
    handlers: {
      command: async (message) => {
        if (host === null) {
          throw new Error('the session host is not ready')
        }
        return commandHandler(host, writer)(message)
      },
    },
  })
  const ready = createSessionHost(linkControlPort(peer, writer), options.decisions(peer))
  host = ready
  let sessions: Record<string, unknown> = {}
  const dialer = dialControlPlane({
    path: options.socket,
    local: NODE_LINK_PROTOCOL,
    node: options.node,
    boot: randomUUID(),
    sessions: () => sessions,
    peer,
    onEvent: (event) => {
      process.stdout.write(`node link: ${JSON.stringify(event)}\n`)
    },
  })
  const refresh = async () => {
    sessions = await snapshot(journal, ready)
  }
  await refresh()
  journal.onAppend(() => void refresh())
  return { host: ready, peer, journal, dialer }
}
