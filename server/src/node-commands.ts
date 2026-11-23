import type { NodeReply } from '@seti/shared'
import type { LiveSession } from './agent-session.js'
import { serveControl } from './node-link.js'
import type { DefaultShapes } from './runtimes/registry.js'
import { liveSessions } from './session-host.js'

const sessionOf = (agent: string): LiveSession | undefined => liveSessions().find(([id]) => id === agent)?.[1]

/** Switches the open process to the mode; 'next_turn' when it has to restart to take it. */
async function setMode(session: LiveSession | undefined, mode: DefaultShapes['mode']): Promise<'now' | 'next_turn'> {
  if (session === undefined || session.closed) {
    return 'now'
  }
  const set = session.openRuntime?.setMode
  if (set === undefined) {
    return 'next_turn'
  }
  return set(mode).then(
    () => 'now',
    () => 'next_turn',
  )
}

/** Takes a message back from the runtime's queue before the agent reads it. */
async function retract(session: LiveSession | undefined, promptId: number): Promise<NodeReply<'queued.retract'>> {
  const uuid = session?.uuidOf(promptId) ?? null
  if (session === undefined || uuid === null) {
    return { outcome: 'missing', promptId: null }
  }
  const cancelled = await session.cancelQueued(uuid)
  if (cancelled === null) {
    return { outcome: 'unsupported', promptId: null }
  }
  return cancelled ? { outcome: 'removed', promptId: session.settle(uuid) } : { outcome: 'taken', promptId: null }
}

serveControl({
  // The control plane read the mode and rules for this runtime.
  'mode.set': async ({ agent, mode }) => ({ applied: await setMode(sessionOf(agent), mode as DefaultShapes['mode']) }),
  'policy.set': async ({ agent, policy }) => {
    await sessionOf(agent)?.applyPermissions(policy as DefaultShapes['policy'])
    return {}
  },
  'queued.retract': async ({ agent, promptId }) => retract(sessionOf(agent), promptId),
  'quiet.restart': ({ agent, at }) => {
    sessionOf(agent)?.restartQuiet(at ?? undefined)
    return {}
  },
  'sessions.view': () => ({
    sessions: liveSessions().map(([agent, { running, heardAt, retrying }]) => ({ agent, running, heardAt, retrying })),
  }),
})
