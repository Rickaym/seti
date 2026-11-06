import { MOD_LIMITS, TASK_STATUSES, type Task } from '@seti/shared'
import { z } from 'zod'
import { tasks } from '../../db.js'
import { scrubValue } from '../../scrub.js'
import { prWatch } from '../../store/pr-watch.js'
import { teamMembers } from '../../store/team.js'
import { taskDigest, transcriptPage } from '../../task-transcript.js'
import type { ModCall } from '../capabilities.js'
import { filterOf, grantOf, visibleTask } from '../scopes.js'
import { defineOp } from './define.js'

const LIST_MAX = 200
const DIGEST_LINES = 20

const taskId = z.string().min(1).max(100)

/** An agent as a mod reads it: who it is and where it stands, never its settings or access. */
const brief = (task: Task, handle: string | null) => ({
  id: task.id,
  title: task.title,
  handle,
  status: task.status,
  pr_urls: task.pr_urls,
  updated_at: task.updated_at,
})

const handleOf = async (id: string) => (await teamMembers.get(id))?.handle ?? null

async function visible(call: ModCall, id: string): Promise<Task> {
  return visibleTask(grantOf(call, 'tasks.read').agents, id)
}

/** The newest entries that fit the byte cap, so one call never hands a mod much of a transcript. */
function capped<T>(entries: readonly T[]): T[] {
  const kept: T[] = []
  let bytes = 0
  for (const entry of entries.toReversed()) {
    bytes += Buffer.byteLength(JSON.stringify(entry))
    if (bytes > MOD_LIMITS.transcriptBytes) {
      break
    }
    kept.unshift(entry)
  }
  return kept
}

export const taskReadOps = {
  'tasks.list': defineOp({
    args: z.strictObject({
      status: z.enum(TASK_STATUSES).optional(),
      limit: z.number().int().min(1).max(LIST_MAX).optional(),
    }),
    run: async (args, { call }) => {
      const covers = await filterOf(grantOf(call, 'tasks.read').agents)
      const handles = new Map((await teamMembers.list()).map((member) => [member.task_id, member.handle]))
      return (await tasks.list())
        .filter((task) => (args.status === undefined || task.status === args.status) && covers(task.id))
        .slice(0, args.limit ?? LIST_MAX)
        .map((task) => brief(task, handles.get(task.id) ?? null))
    },
  }),
  'tasks.get': defineOp({
    args: z.strictObject({ id: taskId }),
    run: async (args, { call }) => {
      const task = await visible(call, args.id)
      const digest = await taskDigest(task.id, DIGEST_LINES)
      return { ...brief(task, await handleOf(task.id)), digest: scrubValue(digest.lines) }
    },
  }),
  'tasks.transcript': defineOp({
    args: z.strictObject({
      id: taskId,
      limit: z.number().int().min(1).max(MOD_LIMITS.transcriptEntries).optional(),
      before: z.coerce.number().int().positive().optional(),
    }),
    run: async (args, { call }) => {
      const task = await visible(call, args.id)
      const page = await transcriptPage(task.id, args.limit ?? MOD_LIMITS.transcriptEntries, args.before)
      return { ...page, messages: capped(scrubValue(page.messages)) }
    },
  }),
  'tasks.prs': defineOp({
    args: z.strictObject({ id: taskId }),
    run: async (args, { call }) => {
      const task = await visible(call, args.id)
      const states = await prWatch.taskStates(task.id)
      return task.pr_urls.map((url) => ({ url, state: states[url] ?? null }))
    },
  }),
}
