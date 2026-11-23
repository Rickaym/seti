import {
  journalEntry,
  NODE_ASKS,
  NODE_COMMANDS,
  type JournalEntry,
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

/** The signal of an ask the node waits on until it is answered. */
const UNTIL_ANSWERED = new AbortController().signal

let control: ControlEnd | null = null

/** Connects the control plane's end of the link; sessions run in this process. */
export function serveNode(end: ControlEnd): void {
  control = end
}

function controlEnd(): ControlEnd {
  if (control === null) {
    throw new Error('No control plane serves the node link')
  }
  return control
}

/**
 * The node's end of the link, the only way the session half reports to or asks the control
 * plane. Each entry and ask is checked against the protocol's schema on the way.
 */
export const nodeLink = {
  /** Reports what happened in the agent's session; resolves once the control plane took it. */
  journal: async (taskId: string, entry: JournalEntry): Promise<void> =>
    controlEnd().journal(taskId, journalEntry.parse(entry)),
  /** Asks the control plane and waits for its answer, or until `signal` aborts. */
  ask: async <K extends NodeAskType>(
    taskId: string,
    type: K,
    ask: NodeAsk<K>,
    signal: AbortSignal = UNTIL_ANSWERED,
  ): Promise<NodeAnswer<K>> => {
    const { answer } = controlEnd()
    const schemas = NODE_ASKS[type]
    return schemas.answer.parse(await answer[type](taskId, schemas.ask.parse(ask), signal))
  },
}

/** What a node does for each command of the control plane. */
export type NodeEnd = { [K in NodeCommandType]: (command: NodeCommand<K>) => Promise<NodeReply<K>> | NodeReply<K> }

let node: NodeEnd | null = null

/** Connects the node's end of the link; sessions run in this process. */
export function serveControl(end: NodeEnd): void {
  node = end
}

/** The control plane's end of the link, the only way it acts on a node's sessions. */
export const controlLink = {
  /** Tells the node to act and waits for its answer. */
  command: async <K extends NodeCommandType>(type: K, command: NodeCommand<K>): Promise<NodeReply<K>> => {
    if (node === null) {
      throw new Error('No node serves the control link')
    }
    const schemas = NODE_COMMANDS[type]
    return schemas.answer.parse(await node[type](schemas.body.parse(command)))
  },
}
