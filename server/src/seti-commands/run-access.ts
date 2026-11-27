import { AWS_ACCESS_ID, HTTPS_PORT, updateTaskInput, type AccessKind, type Task } from '@seti/shared'
import { resetTaskAccess } from '../access-reset.js'
import { setTaskAccess } from '../agent-access.js'
import { HttpError } from '../http.js'
import { updateTask } from '../task-actions.js'
import { allowTaskHost, removeTaskHost } from '../task-hosts.js'

const STATES: Readonly<Record<string, boolean | null>> = { on: true, off: false, reset: null }

function stateOf(op: string): boolean | null {
  const state = STATES[op]
  if (state === undefined) {
    throw new HttpError(400, `No operation ${op}`)
  }
  return state
}

const patch = async (task: Task, fields: Record<string, unknown>) => updateTask(task.id, updateTaskInput.parse(fields))

const setItem = async (task: Task, kind: AccessKind, id: string, op: string) =>
  setTaskAccess(task, { kind, id, enabled: stateOf(op) })

async function runHost(task: Task, host: string, op: string): Promise<void> {
  if (op === 'add') {
    await allowTaskHost(task, `${host}:${String(HTTPS_PORT)}`)
    return
  }
  await removeTaskHost(task, host)
}

/** Runs `/seti:access ...` through the functions the access dialog's routes call. */
export async function runAccess(task: Task, words: readonly string[]): Promise<unknown> {
  const [first = '', key = '', op = ''] = words
  switch (first) {
    case 'reset':
      return resetTaskAccess(task)
    case 'credential':
      return patch(task, { profile_id: key })
    case 'home':
      return patch(task, { home_access: false })
    case 'host':
      return runHost(task, key, op)
    case 'aws':
      return setItem(task, 'aws', AWS_ACCESS_ID, key)
    case 'ssh':
    case 'mcp':
    case 'plugin':
    case 'pack':
      return setItem(task, first, key, op)
    default:
      throw new HttpError(400, `/seti:access ${first} opens a dialog in the agent's settings`)
  }
}
