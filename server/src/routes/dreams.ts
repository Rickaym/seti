import { dreamNowInput } from '@seti/shared'
import { Hono } from 'hono'
import { startDream } from '../dreams/start.js'
import { refuseOnSelf } from '../ea-guard.js'
import { ok, validJson } from '../http.js'
import { dreamRuns } from '../store/dreams.js'
import { requireTask } from '../tasks.js'

const LISTED = 14

export const taskDreamRoutes = new Hono()
  .get('/:id/dreams', async (c) => ok(c, await dreamRuns.forTask((await requireTask(c.req.param('id'))).id, LISTED)))
  .post('/:id/dream', validJson(dreamNowInput), async (c) => {
    const task = await requireTask(c.req.param('id'))
    refuseOnSelf(task.id, 'start a dream of')
    return ok(c, await startDream(task))
  })
