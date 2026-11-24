import { codexSettingsInput } from '@seti/shared'
import { Hono } from 'hono'
import { codexStatus, updateCodexSettings } from '../codex-status.js'
import { eaReadOnly } from '../ea-guard.js'
import { ok, validJson } from '../http.js'

/** The EA and mods may read where each runtime stands, never change it. */
const userOnly = eaReadOnly('change the Codex runtime settings')

export const runtimeRoutes = new Hono()
  .use('*', userOnly)
  .get('/', async (c) => ok(c, { codex: await codexStatus() }))
  .put('/codex', validJson(codexSettingsInput), async (c) => ok(c, await updateCodexSettings(c.req.valid('json'))))
