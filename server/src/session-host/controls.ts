import type { LiveSession } from '../agent-session.js'
import type { SessionCommands } from './port.js'

type Controls = Pick<
  SessionCommands,
  'restartQuiet' | 'setMode' | 'applyPermissions' | 'cancelQueued' | 'cutForRestart'
>

/** The commands that act on an open session's process and queue directly. */
export function sessionControls(live: ReadonlyMap<string, LiveSession>): Controls {
  return {
    restartQuiet: (taskId, at) => {
      live.get(taskId)?.restartQuiet(at)
    },
    setMode: async (taskId, mode) => {
      const session = live.get(taskId)
      if (session === undefined || session.closed) {
        return 'now'
      }
      const query = session.openQuery
      if (query === null) {
        return 'next_turn'
      }
      return query.setPermissionMode(mode).then(
        () => 'now',
        () => 'next_turn',
      )
    },
    applyPermissions: async (taskId, permissions) => {
      await live.get(taskId)?.applyPermissions(permissions)
    },
    cancelQueued: async (taskId, promptId) => {
      const session = live.get(taskId)
      const uuid = session?.uuidOf(promptId) ?? null
      if (session === undefined || uuid === null) {
        return 'not_queued'
      }
      const cancelled = await session.cancelQueued(uuid)
      if (cancelled === null) {
        return 'unsupported'
      }
      return cancelled ? { taken: session.settle(uuid) } : 'picked_up'
    },
    cutForRestart: async (taskIds) => {
      const cut = [...live].filter(([taskId]) => taskIds.includes(taskId))
      for (const [, session] of cut) {
        session.cutForRestart()
      }
      await Promise.allSettled(cut.map(async ([, session]) => session.done))
    },
  }
}
