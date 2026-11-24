import { taskParams, workspaceId } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { ok, valid } from '../http.js'
import { settingsDoc, settingsDocJsonSchema } from '../settings-doc/document.js'
import { agentSettingsDoc, scopedJsonSchema, workspaceSettingsDoc } from '../settings-doc/scoped.js'

const workspaceParams = z.object({ id: workspaceId })

/** Every setting as one JSON document, an agent's or workspace's own, and schemas; read only. */
export const settingsDocRoutes = new Hono()
  .get('/', async (c) => ok(c, await settingsDoc()))
  .get('/schema', async (c) => ok(c, await settingsDocJsonSchema()))
  .get('/schema/agent', (c) => ok(c, scopedJsonSchema('agent')))
  .get('/schema/workspace', (c) => ok(c, scopedJsonSchema('workspace')))
  .get('/agents/:id', valid('param', taskParams), async (c) => ok(c, await agentSettingsDoc(c.req.valid('param').id)))
  .get('/workspaces/:id', valid('param', workspaceParams), async (c) =>
    ok(c, await workspaceSettingsDoc(c.req.valid('param').id)),
  )
