import {
  journalEntry,
  NODE_ASKS,
  type JournalEntry,
  type NodeAnswer,
  type NodeAsk,
  type NodeAskType,
} from '@seti/shared'

/** What the control plane does with what a node reports and asks about one agent. */
export interface ControlEnd {
  journal(taskId: string, entry: JournalEntry): Promise<void>
  answer: { [K in NodeAskType]: (taskId: string, ask: NodeAsk<K>) => Promise<NodeAnswer<K>> }
}

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
  /** Asks the control plane and waits for its answer. */
  ask: async <K extends NodeAskType>(taskId: string, type: K, ask: NodeAsk<K>): Promise<NodeAnswer<K>> => {
    const { answer } = controlEnd()
    const schemas = NODE_ASKS[type]
    return schemas.answer.parse(await answer[type](taskId, schemas.ask.parse(ask)))
  },
}
