import type { NodeMessageOf } from '@seti/shared'
import { z } from 'zod'
import type { SessionView } from '../agent-session.js'
import { remoteSessionCommands } from './commands.js'
import { NodeIngest, type SessionSnapshot } from './ingest.js'
import type { AskReply } from '../node-link/exchange.js'
import { LinkPeer } from '../node-link/link.js'
import type { ReplyStore } from '../node-link/stores.js'
import { listenForNodes, type NodeServer } from '../node-link/transport.js'
import { PORT_ASKS, type PortAsk } from '../session-host/link-kinds.js'
import { NODE_LINK_PROTOCOL } from '../session-host/link-protocol.js'
import type { ControlPort, SessionCommands } from '../session-host/port.js'
import { createControlPort } from '../session-ingest.js'
import { sessionTaskIds } from '../session-mirror.js'
import { nodeAsks, nodeBoots } from '../store/nodes.js'

/** Answers to asks, kept in the database a day so a retry after a restart gets the same one. */
const askStore: ReplyStore<AskReply> = {
  get: async (id) => {
    const stored = await nodeAsks.get(id)
    return stored === undefined ? undefined : (JSON.parse(stored) as AskReply)
  },
  put: async (id, value) => nodeAsks.put(id, JSON.stringify(value)),
}

const snapshotSchema = z.record(
  z.string(),
  z.object({
    view: z.custom<SessionView>((value) => typeof value === 'object').nullable(),
    unstarted: z.object({ first: z.string().nullable() }).nullable(),
    seq: z.number().int().nonnegative(),
  }),
)

const isPortAsk = (kind: string): kind is PortAsk => Object.hasOwn(PORT_ASKS, kind)

/** Other asks a node makes, such as a session's decisions; the node PR registers them. */
type AskAnswerer = (message: NodeMessageOf<'ask'>, signal: AbortSignal) => Promise<AskReply> | null

async function answerPortAsk(port: ControlPort, kind: PortAsk, taskId: string, body: unknown): Promise<unknown> {
  if (kind === 'turn.open') {
    const { next, queued } = PORT_ASKS[kind].parse(body)
    return port.openTurn(taskId, next, queued)
  }
  if (kind === 'session.spec') {
    return port.sessionSpec(taskId)
  }
  if (kind === 'task.exists') {
    return port.taskExists(taskId)
  }
  await port.opening(taskId)
  return null
}

export interface ControlLinkOptions {
  /** Called when a node says hello from a new boot, once the journals it had are stored. */
  onNodeBoot?: (node: string) => Promise<void>
  answer?: AskAnswerer
}

/** The records side of the link to the local session process: its peer, ingest and commands. */
export class ControlLink {
  readonly commands: SessionCommands
  private readonly port: ControlPort
  private readonly ingest: NodeIngest
  private readonly peer: LinkPeer
  private readonly options: ControlLinkOptions

  constructor(options: ControlLinkOptions = {}) {
    this.options = options
    this.port = createControlPort(() => this.commands, { detachListeners: true })
    this.ingest = new NodeIngest(this.port)
    this.peer = new LinkPeer({
      cursors: this.ingest,
      askAnswers: askStore,
      handlers: { ask: async (message, signal) => this.answer(message, signal) },
      onEvent: (event) => {
        process.stdout.write(`node link: ${JSON.stringify(event)}\n`)
      },
    })
    this.commands = remoteSessionCommands(this.peer, this.ingest)
  }

  get connected(): boolean {
    return this.peer.connected
  }

  async listen(path: string): Promise<NodeServer> {
    return listenForNodes({
      path,
      local: NODE_LINK_PROTOCOL,
      cursorsFor: async (hello) => {
        await this.hello(hello)
        return this.ingest.list()
      },
      peerFor: () => this.peer,
    })
  }

  /** Takes the node's sessions as the mirror, and after a new boot resumes what it cut. */
  async hello(hello: NodeMessageOf<'hello'>): Promise<void> {
    const sessions: Record<string, SessionSnapshot> = snapshotSchema.parse(hello.sessions)
    for (const taskId of sessionTaskIds().filter((id) => (sessions[id]?.view ?? null) === null)) {
      this.port.view(taskId, null)
    }
    this.ingest.applySnapshot(sessions)
    const previous = await nodeBoots.swap(hello.node, hello.boot)
    if (previous !== undefined && previous !== hello.boot && this.options.onNodeBoot !== undefined) {
      const stored = Object.entries(sessions).map(async ([taskId, { seq }]) => this.ingest.reachedAt(taskId, seq))
      const booted = this.options.onNodeBoot
      void Promise.all(stored).then(async () => booted(hello.node))
    }
  }

  private async answer(message: NodeMessageOf<'ask'>, signal: AbortSignal): Promise<AskReply> {
    const { kind, agent } = message
    if (isPortAsk(kind)) {
      const { after } = PORT_ASKS[kind].parse(message.body)
      await this.ingest.reachedAt(agent, after)
      return { kind: 'answer', body: await answerPortAsk(this.port, kind, agent, message.body) }
    }
    return (await this.options.answer?.(message, signal)) ?? { kind: 'cancel' }
  }
}
