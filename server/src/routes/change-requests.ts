import { answerChangeInput, changeRequestParams, taskHostParams } from '@seti/shared'
import { Hono } from 'hono'
import { answerChangeRequest, pendingChanges, removeTaskHost } from '../change-requests.js'
import { eaReadOnly } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import { requireTask } from '../tasks.js'

/** The EA may list an agent's requests to remind the user, never answer them. */
const userOnly = eaReadOnly("answer an agent's change requests or change its own hosts")

/** What agents ask the user for, and the hosts the user allowed for one agent alone. */
export const changeRequestRoutes = new Hono()
  .get('/:id/change-requests', async (c) => ok(c, await pendingChanges((await requireTask(c.req.param('id'))).id)))
  .post(
    '/:id/change-requests/:request_id',
    userOnly,
    valid('param', changeRequestParams),
    validJson(answerChangeInput),
    async (c) => {
      const { id, request_id } = c.req.valid('param')
      return ok(c, await answerChangeRequest(await requireTask(id), request_id, c.req.valid('json')))
    },
  )
  .delete('/:id/hosts/:entry', userOnly, valid('param', taskHostParams), async (c) => {
    const { id, entry } = c.req.valid('param')
    return ok(c, await removeTaskHost(await requireTask(id), entry))
  })
