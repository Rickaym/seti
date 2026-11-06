import { reminderCreateInput, reminderTestInput, reminderUpdateInput } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { HOOK_ID } from '../channels/signature.js'
import { ok, valid, validJson } from '../http.js'
import { createReminder, runReminderNow, testReminder, updateReminder } from '../reminders/actions.js'
import { reminders } from '../reminders/service.js'

const idParam = z.object({ id: z.string().regex(HOOK_ID) })
const RUN_HISTORY = 10

/** Reminders: scripts Seti runs on an interval in a locked-down process; a message is an event. */
export const reminderRoutes = new Hono()
  .post('/', validJson(reminderCreateInput), async (c) => ok(c, await createReminder(c.req.valid('json'))))
  .post('/test', validJson(reminderTestInput), async (c) => ok(c, await testReminder(c.req.valid('json'))))
  .get('/:id', valid('param', idParam), async (c) => ok(c, await reminders.info(c.req.valid('param').id)))
  .put('/:id', valid('param', idParam), validJson(reminderUpdateInput), async (c) =>
    ok(c, await updateReminder(c.req.valid('param').id, c.req.valid('json'))),
  )
  .post('/:id/run', valid('param', idParam), async (c) => ok(c, await runReminderNow(c.req.valid('param').id)))
  .get('/:id/runs', valid('param', idParam), async (c) =>
    ok(c, await reminders.runs(c.req.valid('param').id, RUN_HISTORY)),
  )
