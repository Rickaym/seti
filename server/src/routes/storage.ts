import { cleanInput, removeOrphansInput, storageScheduleInput } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { ok, valid, validJson } from '../http.js'
import { cleanAgent, planClean } from '../storage-clean.js'
import { removeOrphans } from '../storage-orphans.js'
import { forgetStorage, storageOverview } from '../storage-overview.js'
import { updateStorageSchedule } from '../storage-schedule.js'
import { requireTask } from '../tasks.js'

const taskParam = z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) })

/** Sizes, Clean, orphans and the schedule; orphans and the schedule are the user's alone. */
export const storageRoutes = new Hono()
  .get('/', async (c) => ok(c, await storageOverview()))
  .get('/agents/:id/clean', valid('param', taskParam), async (c) =>
    ok(c, (await planClean(await requireTask(c.req.valid('param').id))).plan),
  )
  .post('/agents/:id/clean', valid('param', taskParam), validJson(cleanInput), async (c) => {
    const task = await requireTask(c.req.valid('param').id)
    const result = await cleanAgent(task, { actor: 'user', dirs: c.req.valid('json').dirs })
    forgetStorage(task.id)
    return ok(c, result)
  })
  .post('/orphans/remove', validJson(removeOrphansInput), async (c) => {
    const result = await removeOrphans(c.req.valid('json').paths)
    forgetStorage(null)
    return ok(c, result)
  })
  .put('/schedule', validJson(storageScheduleInput), async (c) =>
    ok(c, await updateStorageSchedule(c.req.valid('json'))),
  )
