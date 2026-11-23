import type { NodeCommand, NodeReply } from '@seti/shared'
import type { LiveSession } from './agent-session.js'
import { liveScopes } from './memory-scope.js'
import { serveControl } from './node-link.js'
import type { DefaultShapes } from './runtimes/registry.js'
import { applyCaps, applyCpuCaps, scopeCpu, scopeMemory } from './scope-limits.js'
import {
  closeIdleSession,
  endSession,
  liveSessions,
  openWarmSession,
  sendTurn,
  stopSessionTask,
  stopTurn,
} from './session-host.js'

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

/** Moves the agents' live scopes to the caps the control plane read for them. */
async function capScopes({ memory, cpu }: NodeCommand<'scopes.cap'>): Promise<void> {
  const memoryOf = new Map(memory.map(({ agent, cap }) => [agent, cap]))
  const cpuOf = new Map(cpu.map(({ agent, cap }) => [agent, cap]))
  await applyCaps(async (agent) => Promise.resolve(memoryOf.get(agent) ?? null))
  await applyCpuCaps(async (agent) => Promise.resolve(cpuOf.get(agent) ?? null))
}

/** Cuts the agents' running turns for a restart and waits for them to end, at most `graceMs`. */
async function cutForRestart(agents: readonly string[], graceMs: number): Promise<void> {
  const cut = agents.flatMap((agent) => sessionOf(agent) ?? [])
  for (const session of cut) {
    session.cutForRestart()
  }
  const ended = Promise.allSettled(cut.map(async (session) => session.done))
  await Promise.race([ended, new Promise((resolve) => setTimeout(resolve, graceMs).unref())])
}

serveControl({
  'sessions.cut': async ({ agents, graceMs }) => {
    await cutForRestart(agents, graceMs)
    return {}
  },
  'turn.send': async ({ agent, message, interrupt }) => ({ outcome: await sendTurn(agent, message, interrupt) }),
  'turn.stop': async ({ agent, deliverQueued }) => ({ stopped: await stopTurn(agent, deliverQueued) }),
  'session.open': async ({ agent }) => {
    await openWarmSession(agent)
    return {}
  },
  'session.close': async ({ agent, onlyIdle }) => {
    if (onlyIdle) {
      return { closed: await closeIdleSession(agent) }
    }
    await endSession(agent)
    return { closed: true }
  },
  'background.stop': async ({ agent, task }) => ({ stopped: await stopSessionTask(agent, task) }),
  'mcp.status': async ({ agent }) => ({ servers: (await sessionOf(agent)?.mcpServerStatus()) ?? null }),
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
  'scopes.read': async ({ agent }) => ({ memory: scopeMemory(agent), cpu: await scopeCpu(agent) }),
  'scopes.agents': () => ({ agents: [...new Set(liveScopes().map((scope) => scope.plan.taskId))] }),
  'scopes.cap': async (body) => {
    await capScopes(body)
    return {}
  },
  'sessions.view': () => ({
    sessions: liveSessions().map(([agent, session]) => ({
      agent,
      open: !session.closed,
      running: session.running,
      heardAt: session.heardAt,
      retrying: session.retrying,
      kind: session.turnKind,
      background: session.backgroundCount,
    })),
  }),
})
