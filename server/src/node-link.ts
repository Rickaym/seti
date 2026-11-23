import { AsyncLocalStorage } from 'node:async_hooks'
import {
  journalEntry,
  type AskFrame,
  NODE_ASKS,
  NODE_COMMANDS,
  type JournalEntry,
  VALUE_ASKS,
  type NodeAnswer,
  type NodeAsk,
  type NodeAskType,
  type NodeCommand,
  type NodeCommandType,
  type NodeReply,
} from '@seti/shared'

/** What the control plane does with what a node reports and asks about one agent. */
export interface ControlEnd {
  journal(taskId: string, entry: JournalEntry): Promise<void>
  /** Answers an ask; `signal` aborts once the node stops waiting for the answer. */
  answer: { [K in NodeAskType]: (taskId: string, ask: NodeAsk<K>, signal: AbortSignal) => Promise<NodeAnswer<K>> }
}

const answering = new AsyncLocalStorage<string>()

/** The id of the node's ask being answered, or null for an ask made in this process. */
export const askBeingAnswered = (): string | null => answering.getStore() ?? null

/** The signal of an ask the node waits on until it is answered. */
const UNTIL_ANSWERED = new AbortController().signal

/** A control plane in another process, reached over the node socket; answers are checked here. */
export interface RemoteControl {
  journal(taskId: string, entry: JournalEntry): Promise<void>
  ask(taskId: string, type: NodeAskType, ask: unknown, signal: AbortSignal): Promise<unknown>
}

let control: ControlEnd | null = null
let remoteControl: RemoteControl | null = null

/** Connects the control plane's end of the link; sessions run in this process. */
export function serveNode(end: ControlEnd): void {
  control = end
}

/** Sends what this node's sessions report and ask to a control plane in another process. */
export function reachControl(remote: RemoteControl): void {
  remoteControl = remote
}

function controlEnd(): ControlEnd {
  if (control === null) {
    throw new Error('No control plane serves the node link')
  }
  return control
}

/** Runs one side of an ask; an ask that carries values fails without saying what went wrong. */
async function valueSafe<T>(type: NodeAskType, run: () => Promise<T>): Promise<T> {
  if (!VALUE_ASKS.has(type)) {
    return run()
  }
  try {
    return await run()
  } catch {
    throw new Error(`The control plane could not answer ${type}`)
  }
}

async function answerHere<K extends NodeAskType>(taskId: string, type: K, ask: unknown, signal: AbortSignal) {
  const schemas = NODE_ASKS[type]
  return valueSafe(type, async () =>
    schemas.answer.parse(await controlEnd().answer[type](taskId, schemas.ask.parse(ask), signal)),
  )
}

/**
 * The node's end of the link, the only way the session half reports to or asks the control
 * plane. Each entry and ask is checked against the protocol's schema on the way.
 */
export const nodeLink = {
  /** Reports what happened in the agent's session; resolves once the control plane took it. */
  journal: async (taskId: string, entry: JournalEntry): Promise<void> => {
    const checked = journalEntry.parse(entry)
    await (remoteControl === null ? controlEnd().journal(taskId, checked) : remoteControl.journal(taskId, checked))
  },
  /** Asks the control plane and waits for its answer, or until `signal` aborts. */
  ask: async <K extends NodeAskType>(
    taskId: string,
    type: K,
    ask: NodeAsk<K>,
    signal: AbortSignal = UNTIL_ANSWERED,
  ): Promise<NodeAnswer<K>> => {
    const schemas = NODE_ASKS[type]
    if (remoteControl === null) {
      return answerHere(taskId, type, ask, signal)
    }
    const remote = remoteControl
    return valueSafe(type, async () =>
      schemas.answer.parse(await remote.ask(taskId, type, schemas.ask.parse(ask), signal)),
    )
  },
  /**
   * Answers an ask a node sent over the socket, checking it as an ask made here. A request the
   * answer records for the user takes the ask's id, so the same ask sent again finds it.
   */
  answer: async ({ id, agent, ask, body }: AskFrame, signal: AbortSignal): Promise<unknown> =>
    answering.run(id, async () => answerHere(agent, ask, body, signal)),
}

/** What a node does for each command of the control plane. */
export type NodeEnd = { [K in NodeCommandType]: (command: NodeCommand<K>) => Promise<NodeReply<K>> | NodeReply<K> }

/** A node in another process, reached over the node socket; its answers are checked here. */
export interface RemoteNode {
  command: (type: NodeCommandType, command: unknown) => Promise<unknown>
  /** Resolves once what the node reported before its last answer about the agent is applied. */
  settled: (agent: string) => Promise<void>
}

let node: NodeEnd | null = null
let remoteNode: RemoteNode | null = null

/** Connects the node's end of the link; sessions run in this process. */
export function serveControl(end: NodeEnd): void {
  node = end
}

/** Sends the control plane's commands to a node in another process. */
export function reachNode(remote: RemoteNode): void {
  remoteNode = remote
}

async function runHere<K extends NodeCommandType>(type: K, command: unknown) {
  if (node === null) {
    throw new Error('No node serves the control link')
  }
  const schemas = NODE_COMMANDS[type]
  return schemas.answer.parse(await node[type](schemas.body.parse(command)))
}

/** The control plane's end of the link, the only way it acts on a node's sessions. */
export const controlLink = {
  /** Tells the node to act and waits for its answer. */
  command: async <K extends NodeCommandType>(type: K, command: NodeCommand<K>): Promise<NodeReply<K>> => {
    const schemas = NODE_COMMANDS[type]
    if (remoteNode === null) {
      return runHere(type, command)
    }
    return schemas.answer.parse(await remoteNode.command(type, schemas.body.parse(command)))
  },
  /** Resolves once the control plane applied what the node reported before its last answer. */
  settled: async (agent: string): Promise<void> => remoteNode?.settled(agent),
  /** Runs a command the control plane sent over the socket, checking it as a command made here. */
  run: async (type: NodeCommandType, command: unknown): Promise<unknown> => runHere(type, command),
}
