import type { HelloFrame } from '@seti/shared'
import { inBackground } from './background.js'
import { NODE_SOCKET } from './config.js'
import { watchInterrupted } from './ea-turn-watch.js'
import { wakeWaiting } from './inputs.js'
import { checkNodeSocket } from './node/socket.js'
import { NodeClient } from './node-client.js'
import { controlLink, nodeLink, reachNode } from './node-link.js'
import { setNodePid } from './node-pid.js'
import { notifyInterrupted } from './notifications.js'
import { proxiesRunBy } from './proxy-owner.js'
import { recordAndCut } from './restart-cut.js'
import { markRestartCut, resumeInterrupted } from './restart-resume.js'
import { keepLeftoverRequests } from './restart-waits.js'
import { openQuerySince } from './session-ingest.js'
import { mirroredAgents } from './session-mirror.js'
import { stopLeftoverScopes } from './stale-scopes.js'
import { nodeCursors } from './store/node-cursors.js'
import { restoreToolCalls } from './tool-calls-restore.js'

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

let taken = false

/**
 * The first node to take this control plane says which asks it still waits on: their requests
 * stay with those asks, and the rest are kept for a late answer, as a restart keeps them. The
 * tool calls its open sessions still run show again.
 */
async function takeOver({ asks, fresh, sessions }: HelloFrame): Promise<void> {
  if (taken) {
    return
  }
  taken = true
  await keepLeftoverRequests(new Set(asks))
  for (const { agent, since } of fresh ? [] : sessions) {
    if (since !== null) {
      await restoreToolCalls(agent, since)
    }
  }
}

/** Runs sessions on the node process behind the socket instead of in this one. */
export async function connectNode(): Promise<void> {
  const client = new NodeClient({
    socket: NODE_SOCKET,
    check: (socket) => {
      checkNodeSocket(socket, uid)
    },
    journal: nodeLink.journal,
    answer: nodeLink.answer,
    cursors: nodeCursors,
    fresh: takeUpLostTurns,
    took: setNodePid,
    taking: takeOver,
    stopping: async () => {
      await recordAndCut("Seti's node")
    },
  })
  proxiesRunBy({
    open: async (task) => {
      await controlLink.command('proxy.open', { agent: task.id, task })
    },
    close: async (agent) => {
      await controlLink.command('proxy.close', { agent }).catch((e: unknown) => {
        const why = e instanceof Error ? e.message : String(e)
        process.stderr.write(`node link: the node keeps the proxy of ${agent} until it restarts: ${why}\n`)
      })
    },
  })
  reachNode({
    command: async (type, body) => client.command(type, body),
    settled: async (agent) => client.settled(agent),
  })
  await client.start()
}
