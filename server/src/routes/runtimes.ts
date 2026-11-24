import { codexSettingsInput, type RuntimesStatus } from '@seti/shared'
import { Hono } from 'hono'
import { codexStatus, updateCodexSettings } from '../codex-status.js'
import { eaReadOnly } from '../ea-guard.js'
import { ok, validJson } from '../http.js'
import { runtimeOffers } from '../runtime-offers.js'
import { runtimeCapabilities } from '../runtimes/capabilities.js'

/** The EA and mods may read where each runtime stands, never change it. */
const userOnly = eaReadOnly('change the Codex runtime settings')

export const runtimeRoutes = new Hono()
  .use('*', userOnly)
  .get('/', async (c) => {
    const codex = await codexStatus()
    return ok(c, { codex, offers: runtimeOffers(codex) } satisfies RuntimesStatus)
  })
  .get('/capabilities', (c) => ok(c, runtimeCapabilities()))
  .put('/codex', validJson(codexSettingsInput), async (c) => ok(c, await updateCodexSettings(c.req.valid('json'))))
