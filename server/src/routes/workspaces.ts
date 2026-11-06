import { workspaceInput } from '@seti/shared'
import { Hono } from 'hono'
import { ok, validJson } from '../http.js'
import { listWorkspaces } from '../task-actions.js'
import { createWorkspace, deleteWorkspace, renameWorkspace } from '../workspaces.js'

export const workspaceRoutes = new Hono()
  .get('/', async (c) => ok(c, await listWorkspaces()))
  .post('/', validJson(workspaceInput), async (c) => ok(c, await createWorkspace(c.req.valid('json').name)))
  .patch('/:id', validJson(workspaceInput), async (c) =>
    ok(c, await renameWorkspace(c.req.param('id'), c.req.valid('json').name)),
  )
  .delete('/:id', async (c) => {
    await deleteWorkspace(c.req.param('id'))
    return c.body(null, 204)
  })
