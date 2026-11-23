import type { NodeAnswer, NodeAsk, RuntimeEvent } from '@seti/shared'
import { tasks } from './db.js'
import { watchSessionMcp } from './mcp-session-status.js'
import { controlLink } from './node-link.js'
import type { ToolServerState } from './runtimes/adapter.js'
import { sessionOpening } from './session-hooks.js'
import { rereadKey, setupKey, startingSpec, type SessionSpec } from './session-spec.js'
import { recordSessionStart } from './session-start.js'
import { rewinds } from './store/rewinds.js'

async function taskOf(taskId: string) {
  const task = await tasks.get(taskId)
  if (!task) {
    throw new Error('Task was deleted before its session started')
  }
  return task
}

/** Reads how the MCP servers of the agent's open process connected, from its node. */
const mcpStatus = (taskId: string) => async (): Promise<ToolServerState[] | null> => {
  const { servers } = await controlLink.command('mcp.status', { agent: taskId })
  // The node read them from the runtime's own status call.
  return servers as ToolServerState[] | null
}

/** What the control plane answers a node about to start an agent's process. */
export const setupAnswers = {
  'session.opening': async (taskId: string): Promise<NodeAnswer<'session.opening'>> => {
    await sessionOpening(taskId)
    return {}
  },
  'session.spec': async (taskId: string): Promise<NodeAnswer<'session.spec'>> => {
    const { spec, key } = await startingSpec(await taskOf(taskId))
    return { spec, key, rewind: (await rewinds.pending(taskId)) ?? null }
  },
  'setup.key': async (taskId: string, { spec }: NodeAsk<'setup.key'>): Promise<NodeAnswer<'setup.key'>> => {
    if (spec !== null && spec !== undefined) {
      // A spec comes back as startingSpec built it.
      return { rewind: false, key: await rereadKey(spec as SessionSpec, await taskOf(taskId)) }
    }
    if ((await rewinds.pending(taskId)) !== undefined) {
      return { rewind: true }
    }
    return { rewind: false, key: await setupKey(await taskOf(taskId)) }
  },
}

/** A process started; one started with no message follows how its MCP servers connect. */
export function processStarted(taskId: string, warm: boolean): void {
  if (warm) {
    void watchSessionMcp(taskId, mcpStatus(taskId))
  }
}

/** Records a session's start from a message's events, with how its MCP servers connect. */
export const recordStart = async (taskId: string, events: readonly RuntimeEvent[]): Promise<void> =>
  recordSessionStart(taskId, events, mcpStatus(taskId))

/** Records how Claude Code took the rewind point a process started at. */
export const settleRewind = async (id: number, state: 'applied' | 'refused', reason: string | null): Promise<void> =>
  rewinds.settle(id, state, reason)
