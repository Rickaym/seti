import { randomUUID } from 'node:crypto'
import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk'
import { HttpError } from '../http.js'
import type { NodeIngest } from './ingest.js'
import type { LinkPeer } from '../node-link/link.js'
import type { CommandDone, CommandKind } from '../session-host/link-kinds.js'
import type { QueuedCancel, SessionCommands } from '../session-host/port.js'

const OFFLINE = 'The session process is not running, so the agent cannot take this now. Start seti-node.'

/**
 * Sends a command to the node and waits until the records side has stored everything the node
 * journaled while it ran it, so what follows reads the sessions as the node left them.
 */
function commander(peer: LinkPeer, ingest: NodeIngest) {
  return async (kind: CommandKind, taskId: string, body: object = {}): Promise<unknown> => {
    if (!peer.connected) {
      throw new HttpError(503, OFFLINE)
    }
    const outcome = await peer.command({ id: randomUUID(), kind, agent: taskId, body })
    if (!outcome.ok) {
      throw new Error(outcome.error)
    }
    const done = outcome.body as CommandDone
    await ingest.reachedAt(taskId, done.seq)
    return done.body
  }
}

/** The session host as the records side reaches it on a node, over the link. */
export function remoteSessionCommands(peer: LinkPeer, ingest: NodeIngest): SessionCommands {
  const command = commander(peer, ingest)
  return {
    start: async (taskId, message, interrupt, check) => {
      await command('start', taskId, { message, interrupt, check })
    },
    openWarm: async (taskId) => {
      await command('open_warm', taskId)
    },
    stop: async (taskId, deliverQueued) => {
      await command('stop', taskId, { deliverQueued })
    },
    end: async (taskId) => {
      await command('end', taskId)
    },
    closeIdle: async (taskId) => (await command('close_idle', taskId)) === true,
    stopTask: async (taskId, sdkTaskId) => (await command('stop_task', taskId, { sdkTaskId })) === true,
    cancelQueued: async (taskId, promptId) => (await command('cancel_queued', taskId, { promptId })) as QueuedCancel,
    setMode: async (taskId, mode) => ((await command('set_mode', taskId, { mode })) === 'now' ? 'now' : 'next_turn'),
    applyPermissions: async (taskId, permissions) => {
      await command('apply_permissions', taskId, { permissions })
    },
    restartQuiet: (taskId, at) => {
      command('restart_quiet', taskId, at === undefined ? {} : { at }).catch(() => undefined)
    },
    cutForRestart: async () => Promise.resolve(),
    mcpStatus: async (taskId) =>
      peer.connected ? ((await command('mcp_status', taskId)) as McpServerStatus[] | null) : null,
  }
}
