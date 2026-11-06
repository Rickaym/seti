import { eaFollowupInput, eaInboxDeliverInput, eaWatchInput, type EaFollowup, type EaInboxItem } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { awaitTurnEnd } from '../agent-waits.js'
import { refuseArchived } from '../archive-guard.js'
import { closeBrief, currentBrief } from '../attention-brief.js'
import { audit } from '../audit.js'
import { now, tasks } from '../db.js'
import { deliverInbox, eaPolled } from '../ea-deliver.js'
import { cancelFollowup, scheduleFollowup } from '../ea-inbox.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { recordCall } from '../presence.js'
import { eaInbox, eaWatches } from '../store/inbox.js'
import { localLabel } from '../when.js'
import { botOnly } from './ea-state.js'

const DUE_BATCH = 50

const idParam = z.object({ id: z.coerce.number().int().positive() })
const taskParam = z.object({ taskId: z.string().min(1).max(100) })
/** The EA polls with `call=1` while a call is live, which tells Seti the user is here. */
const dueQuery = z.object({ call: z.literal('1').optional() })

const withLocalDue = (item: EaInboxItem): EaFollowup => ({
  ...item,
  local_due: localLabel(new Date(item.due_at), item.timezone ?? 'UTC'),
})

/** The EA inbox: follow-ups and reminders, watched tasks, and delivery of what is due. */
export const eaInboxRoutes = new Hono()
  .get('/inbox/due', botOnly, valid('query', dueQuery), async (c) => {
    eaPolled()
    if (c.req.valid('query').call !== undefined) {
      recordCall()
    }
    return ok(c, await eaInbox.due(now(), DUE_BATCH))
  })
  .get('/brief', botOnly, async (c) => {
    recordCall()
    const brief = await currentBrief()
    if (brief !== null) {
      await closeBrief(brief.id)
    }
    return ok(c, { brief })
  })
  .post('/inbox/deliver', botOnly, validJson(eaInboxDeliverInput), async (c) => {
    const { ids, via, notify } = c.req.valid('json')
    return ok(c, await deliverInbox(ids, via, new Date(), notify))
  })
  .get('/inbox/unread', async (c) => ok(c, await eaInbox.unread(now())))
  .post('/inbox/read', async (c) => ok(c, { acknowledged: await eaInbox.acknowledge(now()) }))
  .get('/followups', async (c) => ok(c, (await eaInbox.scheduled()).map(withLocalDue)))
  .post('/followups', validJson(eaFollowupInput), async (c) => ok(c, await scheduleFollowup(c.req.valid('json'))))
  .delete('/followups/:id', valid('param', idParam), async (c) =>
    ok(c, withLocalDue(await cancelFollowup(c.req.valid('param').id))),
  )
  .get('/watches', async (c) => ok(c, await eaWatches.list()))
  .post('/watches', validJson(eaWatchInput), async (c) => {
    const input = c.req.valid('json')
    const task = await tasks.get(input.task_id)
    if (!task) {
      throw new HttpError(404, 'Task not found')
    }
    refuseArchived(task)
    if (input.once) {
      return ok(c, await awaitTurnEnd(task))
    }
    const watch = await eaWatches.add(task.id, input.note, now())
    await audit.record({
      actor: 'user',
      kind: 'ea.watch_added',
      subject_type: 'task',
      subject_id: task.id,
      summary: `The EA watches task "${task.title}"`,
      detail: { title: task.title, note: input.note },
    })
    return ok(c, watch)
  })
  .delete('/watches/:taskId', valid('param', taskParam), async (c) => {
    const { taskId } = c.req.valid('param')
    const watch = await eaWatches.get(taskId)
    if (watch === undefined || !(await eaWatches.remove(taskId))) {
      throw new HttpError(404, 'The EA does not watch that task')
    }
    await audit.record({
      actor: 'user',
      kind: 'ea.watch_removed',
      subject_type: 'task',
      subject_id: taskId,
      summary: `The EA stopped watching task "${watch.task_title}"`,
      detail: { title: watch.task_title },
    })
    return ok(c, watch)
  })
