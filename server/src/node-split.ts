import { inBackground } from './background.js'
import { NODE_SOCKET } from './config.js'
import { watchInterrupted } from './ea-turn-watch.js'
import { wakeWaiting } from './inputs.js'
import { checkNodeSocket } from './node/socket.js'
import { NodeClient } from './node-client.js'
import { nodeLink, reachNode } from './node-link.js'
import { notifyInterrupted } from './notifications.js'
import { recordAndCut } from './restart-cut.js'
import { markRestartCut, resumeInterrupted } from './restart-resume.js'
import { openQuerySince } from './session-ingest.js'
import { mirroredAgents } from './session-mirror.js'
import { stopLeftoverScopes } from './stale-scopes.js'
import { nodeCursors } from './store/node-cursors.js'

const CLOSED = { open: false, running: false, accepting: false, autoQueued: false, background: 0 }

/** Closes the sessions a stopped node had open, as their own close would have. */
async function forgetLostSessions(): Promise<void> {
  for (const agent of mirroredAgents()) {
    const since = openQuerySince(agent)
    await nodeLink.journal(agent, { type: 'session.changed', ...CLOSED })
    await nodeLink.journal(agent, { type: 'session.closed', since })
    await nodeLink.journal(agent, { type: 'session.state', open: false, background: 0 })
  }
}

/**
 * A new node process: the turns the old one ran are cut, as a restart of a single process cuts
 * them, and resume once the new node is taken.
 */
async function takeUpLostTurns(): Promise<() => void> {
  await forgetLostSessions()
  await stopLeftoverScopes()
  const interrupted = await markRestartCut()
  notifyInterrupted(interrupted.notify)
  watchInterrupted(interrupted.notify)
  return () => {
    void wakeWaiting(interrupted.resume.map((each) => each.taskId))
    inBackground('resume', async () => resumeInterrupted(interrupted.resume))
  }
}

const uid = process.getuid?.() ?? -1

/** Runs sessions on the node process behind the socket instead of in this one. */
export async function connectNode(): Promise<void> {
  const client = new NodeClient({
    socket: NODE_SOCKET,
    check: (socket) => {
      checkNodeSocket(socket, uid)
    },
    journal: nodeLink.journal,
    answer: async ({ agent, ask, body }, signal) => nodeLink.answer(agent, ask, body, signal),
    cursors: nodeCursors,
    fresh: takeUpLostTurns,
    stopping: async () => {
      await recordAndCut("Seti's node")
    },
  })
  reachNode(async (type, body) => client.command(type, body))
  await client.start()
}
