import {
  memoryCapInput,
  restartSessionInput,
  setBypassInput,
  updateTaskInput,
  type SetiCommand,
  type Task,
} from '@seti/shared'
import { archiveTask } from '../archive.js'
import { setBypass } from '../bypass.js'
import { setTaskCpuCap } from '../cpu-cap.js'
import { setTaskDreaming } from '../dreams/settings.js'
import { startDream } from '../dreams/start.js'
import { HttpError } from '../http.js'
import { setTaskMemoryCap, taskMemoryCap } from '../memory-cap.js'
import { restartSession } from '../session-restart.js'
import { updateTask } from '../task-actions.js'
import { updateMember } from '../team.js'
import { runAccess } from './run-access.js'

type Runner = (task: Task, words: readonly string[]) => Promise<unknown>

const patch = async (task: Task, fields: Record<string, unknown>) => updateTask(task.id, updateTaskInput.parse(fields))

/** A runner that sets one field of the agent from the command's value. */
const field =
  (map: (value: string) => Record<string, unknown>): Runner =>
  async (task, [value = '']) =>
    patch(task, map(value))

const on = (value: string) => value === 'on'

async function runMemory(task: Task, [value = '']: readonly string[]) {
  if (value === 'default') {
    return setTaskMemoryCap(task, null)
  }
  const mb = Number(value)
  const swap = (await taskMemoryCap(task.id)).effective.swap_max_mb
  return setTaskMemoryCap(task, memoryCapInput.parse({ high_mb: mb, max_mb: mb, swap_max_mb: swap }))
}

async function runCpu(task: Task, [value = '']: readonly string[]) {
  if (value === 'default') {
    return setTaskCpuCap(task, null)
  }
  return setTaskCpuCap(task, { quota_percent: value === 'none' ? null : Number(value) })
}

/**
 * How each Seti command runs, by its name: the same functions the agent's settings call, so a
 * command is refused, applied and audited as there. A command with no runner opens a dialog.
 */
export const SETI_RUNNERS: Readonly<Record<string, Runner>> = {
  access: runAccess,
  mcp: async (task, words) => runAccess(task, ['mcp', ...words]),
  sandbox: field((value) => ({ sandbox: on(value) })),
  control: field((value) => ({ seti_control: value })),
  updates: field((value) => ({ input_mode: value })),
  color: field((value) => ({ color: value === 'none' ? null : value })),
  notify: field((value) => ({ notifications_muted: !on(value) })),
  pin: field((value) => ({ pinned: on(value) })),
  workspace: field((value) => ({ workspace_id: value })),
  rename: field((value) => ({ title: value })),
  bypass: async (task, [value = '']) =>
    setBypass(task, setBypassInput.parse({ hours: value === 'off' ? null : Number(value) }).hours),
  chat: async (task, [value = '']) => updateMember(task.id, { muted: !on(value) }, 'user'),
  nightly: async (task, [value = '']) => setTaskDreaming(task, on(value)),
  memory: runMemory,
  cpu: runCpu,
  restart: async (task) => restartSession(task, restartSessionInput.parse({ interrupt: true })),
  archive: async (task) => archiveTask(task.id, { actor: 'user', removeWorktree: true }),
  dream: async (task) => startDream(task),
}

/** Runs a parsed Seti command on the agent; one that opens a dialog is the browser's to do. */
export async function runSetiCommand(task: Task, command: SetiCommand): Promise<void> {
  const [name = '', ...words] = command.keys
  const runner = SETI_RUNNERS[name]
  if (runner === undefined) {
    throw new HttpError(400, `${command.line} opens a dialog in the agent's settings`)
  }
  await runner(task, words)
}
