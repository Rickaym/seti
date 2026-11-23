import type { NodeAnswer, NodeAsk, NodeAskType } from '@seti/shared'
import { ValueLate } from './egress-answers.js'
import { nodeLink } from './node-link.js'

/** How long a request waits for a value, as while the control plane restarts, before a 503. */
const VALUE_WAIT_MS = 30_000

/**
 * Asks the control plane for a value a request needs. It waits through a restart of the control
 * plane for up to `waitMs`, then fails as late; the node keeps no value to fall back on.
 */
export async function askValue<K extends NodeAskType>(
  taskId: string,
  type: K,
  ask: NodeAsk<K>,
  waitMs = VALUE_WAIT_MS,
): Promise<NodeAnswer<K>> {
  const signal = AbortSignal.timeout(waitMs)
  try {
    return await nodeLink.ask(taskId, type, ask, signal)
  } catch (e) {
    throw signal.aborted ? new ValueLate() : e
  }
}
