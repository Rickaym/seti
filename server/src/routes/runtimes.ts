import { codexSettingsInput, geminiSettingsInput, type RuntimesStatus } from '@seti/shared'
import { Hono } from 'hono'
import { claudeStatus } from '../claude-status.js'
import { codexStatus, retryCodex, updateCodexSettings } from '../codex-status.js'
import { eaReadOnly } from '../ea-guard.js'
import { geminiStatus, retryGemini, updateGeminiSettings } from '../gemini-status.js'
import { ok, validJson } from '../http.js'
import { runtimeOffers } from '../runtime-offers.js'
import { runtimeCapabilities } from '../runtimes/capabilities.js'

/** The EA and mods may read where each runtime stands, never change it. */
const userOnly = eaReadOnly('change the runtime settings')

export const runtimeRoutes = new Hono()
  .use('*', userOnly)
  .get('/', async (c) => {
    const [codex, gemini] = await Promise.all([codexStatus(), geminiStatus()])
    return ok(c, {
      claude: await claudeStatus(),
      codex,
      gemini,
      offers: runtimeOffers(codex, gemini),
    } satisfies RuntimesStatus)
  })
  .get('/capabilities', (c) => ok(c, runtimeCapabilities()))
  .put('/codex', validJson(codexSettingsInput), async (c) => ok(c, await updateCodexSettings(c.req.valid('json'))))
  .post('/codex/retry', async (c) => ok(c, await retryCodex()))
  .put('/gemini', validJson(geminiSettingsInput), async (c) => ok(c, await updateGeminiSettings(c.req.valid('json'))))
  .post('/gemini/retry', async (c) => ok(c, await retryGemini()))
