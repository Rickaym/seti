import { codexSettingsInput, offerOf, type CodexStatus, type RuntimesStatus } from '@seti/shared'
import { Hono } from 'hono'
import { codexStatus, retryCodex, updateCodexSettings } from '../codex-status.js'
import { eaReadOnly } from '../ea-guard.js'
import { ok, validJson } from '../http.js'

/** The EA and mods may read where each runtime stands, never change it. */
const userOnly = eaReadOnly('change the Codex runtime settings')

/** Claude Code always, and Codex only while a new agent may start on it. */
const offers = (codex: CodexStatus) => [offerOf('claude'), ...(codex.state === 'ready' ? [offerOf('codex')] : [])]

export const runtimeRoutes = new Hono()
  .use('*', userOnly)
  .get('/', async (c) => {
    const codex = await codexStatus()
    return ok(c, { codex, offers: offers(codex) } satisfies RuntimesStatus)
  })
  .put('/codex', validJson(codexSettingsInput), async (c) => ok(c, await updateCodexSettings(c.req.valid('json'))))
  .post('/codex/retry', async (c) => ok(c, await retryCodex()))
