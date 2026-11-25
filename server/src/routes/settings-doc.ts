import { settingsPatchInput, taskParams, workspaceId } from '@seti/shared'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { currentRequestSource } from '../access.js'
import { HttpError, ok, valid, validJson } from '../http.js'
import { byUser } from '../revisions.js'
import { settingsDoc, settingsDocDefaults, settingsDocJsonSchema } from '../settings-doc/document.js'
import { agentSettingsDoc, scopedJsonSchema, workspaceSettingsDoc } from '../settings-doc/scoped.js'
import { SettingsRefused, writeSettings } from '../settings-doc/write.js'

const workspaceParams = z.object({ id: workspaceId })
const docQuery = z.object({ only: z.literal('modified').optional() })

/** A whole settings document is a few tens of KB; this leaves room and refuses anything larger. */
const PATCH_BYTES_MAX = 512 * 1024

/** Only you write settings as JSON: the EA, agents, mods and paired devices are refused here. */
function userOnly(): void {
  const via = currentRequestSource()?.via
  if (via !== undefined && via !== 'session' && via !== 'local') {
    throw new HttpError(403, 'Only you change settings as JSON, signed in to Seti')
  }
}

/** Every setting as one JSON document, its defaults, an agent's or workspace's own, and schemas. */
export const settingsDocRoutes = new Hono()
  .get('/', valid('query', docQuery), async (c) =>
    ok(c, await settingsDoc({ modified: c.req.valid('query').only === 'modified' })),
  )
  .get('/defaults', async (c) => ok(c, await settingsDocDefaults()))
  .patch('/', bodyLimit({ maxSize: PATCH_BYTES_MAX }), validJson(settingsPatchInput), async (c) => {
    userOnly()
    try {
      return ok(c, await writeSettings(c.req.valid('json'), byUser('Changed as JSON')))
    } catch (e) {
      if (e instanceof SettingsRefused) {
        return c.json({ error: e.refusal }, e.status)
      }
      throw e
    }
  })
  .get('/schema', async (c) => ok(c, await settingsDocJsonSchema()))
  .get('/schema/agent', (c) => ok(c, scopedJsonSchema('agent')))
  .get('/schema/workspace', (c) => ok(c, scopedJsonSchema('workspace')))
  .get('/agents/:id', valid('param', taskParams), async (c) => ok(c, await agentSettingsDoc(c.req.valid('param').id)))
  .get('/workspaces/:id', valid('param', workspaceParams), async (c) =>
    ok(c, await workspaceSettingsDoc(c.req.valid('param').id)),
  )
