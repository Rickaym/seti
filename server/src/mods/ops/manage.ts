import { agentColorInput, prUrl, type ModTaskAction, type Task } from '@seti/shared'
import { z } from 'zod'
import { HttpError } from '../../http.js'
import { linkTaskPr, renameTask, setTaskColor, setTaskPinned, unlinkTaskPr } from '../../tasks.js'
import { askUser } from '../asks.js'
import type { ModCall } from '../capabilities.js'
import { grantOf, readFilter, visibleTask } from '../scopes.js'
import { defineOp } from './define.js'

const taskId = z.string().min(1).max(100)

/** Refuses an action the grant does not list. */
function requireAction(call: ModCall, action: ModTaskAction): void {
  if (!grantOf(call, 'tasks.manage').actions.includes(action)) {
    throw new HttpError(403, `The mod ${call.modId} was not granted tasks.manage for ${action}`)
  }
}

/** The agent an action targets, once the action is granted and the agent is within the filter. */
async function target(call: ModCall, action: ModTaskAction, id: string): Promise<Task> {
  requireAction(call, action)
  return visibleTask(readFilter(call), id)
}

const brief = (task: Task) => ({ id: task.id, title: task.title, pinned: task.pinned, color: task.color })

/** What a mod may change on an agent; start and stop only ask the user. */
export const manageOps = {
  'tasks.manage.rename': defineOp({
    args: z.strictObject({ id: taskId, title: z.string().trim().min(1).max(200) }),
    run: async (args, { call }) => {
      const task = await target(call, 'rename', args.id)
      await renameTask(task, args.title)
      return brief({ ...task, title: args.title })
    },
  }),
  'tasks.manage.pin': defineOp({
    args: z.strictObject({ id: taskId, on: z.boolean() }),
    run: async (args, { call }) => {
      const task = await target(call, 'pin', args.id)
      await setTaskPinned(task, args.on)
      return brief({ ...task, pinned: args.on })
    },
  }),
  'tasks.manage.set_color': defineOp({
    args: z.strictObject({ id: taskId, color: agentColorInput.nullable() }),
    run: async (args, { call }) => {
      const task = await target(call, 'set_color', args.id)
      await setTaskColor(task, args.color)
      return brief({ ...task, color: args.color })
    },
  }),
  'tasks.manage.link_pr': defineOp({
    args: z.strictObject({ id: taskId, url: prUrl }),
    run: async (args, { call }) => {
      const task = await target(call, 'link_pr', args.id)
      return { linked: await linkTaskPr(task.id, args.url) }
    },
  }),
  'tasks.manage.unlink_pr': defineOp({
    args: z.strictObject({ id: taskId, url: prUrl }),
    run: async (args, { call }) => {
      const task = await target(call, 'unlink_pr', args.id)
      return { unlinked: await unlinkTaskPr(task.id, args.url) }
    },
  }),
  'tasks.manage.start': defineOp({
    args: z.strictObject({
      title: z.string().trim().min(1).max(200),
      prompt: z.string().trim().min(1).max(20_000),
      repo: z.uuid().optional(),
    }),
    run: async (args, { call, manifest }) => {
      requireAction(call, 'start')
      return askUser(call, { name: manifest.name, op: 'tasks.manage.start', args })
    },
  }),
  'tasks.manage.stop': defineOp({
    args: z.strictObject({ id: taskId }),
    run: async (args, { call, manifest }) => {
      const task = await target(call, 'stop', args.id)
      return askUser(call, { name: manifest.name, op: 'tasks.manage.stop', args: { id: task.id }, target: task.title })
    },
  }),
}
