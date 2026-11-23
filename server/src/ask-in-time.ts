import type { NodeAnswer, NodeAsk, NodeAskType } from '@seti/shared'
import { ControlLate } from './egress-answers.js'
import { nodeLink } from './node-link.js'

/** How long a request waits for an answer, as while the control plane restarts, before a 503. */
const ASK_WAIT_MS = 30_000

/**
 * Asks the control plane for what a request through the proxy needs. It waits through a restart
 * of the control plane for up to `waitMs`, then fails as late; the node keeps no value to fall
 * back on.
 */
export async function askInTime<K extends NodeAskType>(
  taskId: string,
  type: K,
  ask: NodeAsk<K>,
  waitMs = ASK_WAIT_MS,
): Promise<NodeAnswer<K>> {
  const signal = AbortSignal.timeout(waitMs)
  try {
    return await nodeLink.ask(taskId, type, ask, signal)
  } catch (e) {
    throw signal.aborted ? new ControlLate() : e
  }
}
