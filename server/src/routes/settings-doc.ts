import { taskParams, workspaceId } from '@seti/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import { ok, valid } from '../http.js'
import { settingsDoc, settingsDocDefaults, settingsDocJsonSchema } from '../settings-doc/document.js'
import { agentSettingsDoc, scopedJsonSchema, workspaceSettingsDoc } from '../settings-doc/scoped.js'

const workspaceParams = z.object({ id: workspaceId })
const docQuery = z.object({ only: z.literal('modified').optional() })

/** Every setting as one JSON document, its defaults, an agent's or workspace's own, and schemas. */
export const settingsDocRoutes = new Hono()
  .get('/', valid('query', docQuery), async (c) =>
    ok(c, await settingsDoc({ modified: c.req.valid('query').only === 'modified' })),
  )
  .get('/defaults', async (c) => ok(c, await settingsDocDefaults()))
  .get('/schema', async (c) => ok(c, await settingsDocJsonSchema()))
  .get('/schema/agent', (c) => ok(c, scopedJsonSchema('agent')))
  .get('/schema/workspace', (c) => ok(c, scopedJsonSchema('workspace')))
  .get('/agents/:id', valid('param', taskParams), async (c) => ok(c, await agentSettingsDoc(c.req.valid('param').id)))
  .get('/workspaces/:id', valid('param', workspaceParams), async (c) =>
    ok(c, await workspaceSettingsDoc(c.req.valid('param').id)),
  )
