import { capabilitiesScopeInput, summarizeCapabilities } from '@seti/shared'
import { Hono } from 'hono'
import { capabilityCache } from '../capabilities.js'
import { ok, valid, validJson } from '../http.js'
import { scopeCwd } from '../mcp-actions.js'
import { withoutGoneServers } from '../mcp-presence.js'
import { withSignIn } from '../mcp-sign-in.js'
import { withRuntimes } from '../runtimes/capabilities.js'

export { scopeCwd }

const validScope = valid('query', capabilitiesScopeInput)

export const capabilityRoutes = new Hono()
  .get('/', validScope, async (c) => {
    const snapshot = await capabilityCache.get(await scopeCwd(c.req.valid('query').repo_id))
    return ok(c, withRuntimes(withSignIn(await withoutGoneServers(snapshot))))
  })
  .get('/summary', validScope, async (c) => {
    const snapshot = capabilityCache.cached(await scopeCwd(c.req.valid('query').repo_id))
    return ok(c, snapshot ? summarizeCapabilities(withSignIn(await withoutGoneServers(snapshot))) : null)
  })
  .post('/refresh', validJson(capabilitiesScopeInput), async (c) =>
    ok(c, withRuntimes(withSignIn(await capabilityCache.refresh(await scopeCwd(c.req.valid('json').repo_id))))),
  )
