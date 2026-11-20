import type { NodeMessageOf } from '@seti/shared'
import { inLane } from '../task-lane.js'
import { COMMANDS, type CommandDone, type CommandKind } from './link-kinds.js'
import type { JournalWriter } from './link-port.js'
import type { SessionCommands } from './port.js'

type Bodies = { [K in CommandKind]: ReturnType<(typeof COMMANDS)[K]['parse']> }
type Runners = { [K in CommandKind]: (taskId: string, body: Bodies[K]) => Promise<unknown> }

/** What each command does to a session; a start runs in the task's lane, behind its messages. */
function runners(commands: SessionCommands): Runners {
  return {
    start: async (taskId, { message, interrupt, check }) =>
      inLane(taskId, async () => commands.start(taskId, message, interrupt, check)),
    open_warm: async (taskId) => inLane(taskId, async () => commands.openWarm(taskId)),
    stop: async (taskId, { deliverQueued }) => commands.stop(taskId, deliverQueued),
    end: async (taskId) => commands.end(taskId),
    close_idle: async (taskId) => commands.closeIdle(taskId),
    stop_task: async (taskId, { sdkTaskId }) => commands.stopTask(taskId, sdkTaskId),
    cancel_queued: async (taskId, { promptId }) => commands.cancelQueued(taskId, promptId),
    set_mode: async (taskId, { mode }) => commands.setMode(taskId, mode),
    apply_permissions: async (taskId, { permissions }) => commands.applyPermissions(taskId, permissions),
    restart_quiet: async (taskId, { at }) => {
      commands.restartQuiet(taskId, at)
      return Promise.resolve(null)
    },
    mcp_status: async (taskId) => commands.mcpStatus(taskId),
  }
}

const isKind = (kind: string): kind is CommandKind => Object.hasOwn(COMMANDS, kind)

async function run(all: Runners, kind: CommandKind, taskId: string, body: unknown): Promise<unknown> {
  const runner = all[kind] as (taskId: string, body: unknown) => Promise<unknown>
  return runner(taskId, COMMANDS[kind].parse(body))
}

/** Runs the records side's commands on this node's sessions, each answered with its journal reach. */
export function commandHandler(commands: SessionCommands, writer: JournalWriter) {
  const all = runners(commands)
  return async (message: NodeMessageOf<'command'>): Promise<CommandDone> => {
    const { kind, agent } = message
    if (!isKind(kind) || agent === undefined) {
      throw new Error(`unsupported command ${kind}`)
    }
    const body = (await run(all, kind, agent, message.body)) ?? null
    return { body, seq: await writer.lastSeq(agent) }
  }
}
