import {
  mcpAuthCompleteInput,
  mcpDefaultInput,
  mcpDefaultParams,
  mcpScopeInput,
  mcpServerInput,
  mcpSignInInput,
  mcpServerNameParam,
  mcpServerRemoveQuery,
} from '@seti/shared'
import { Hono } from 'hono'
import { fromEa, notEa, refuseEa } from '../ea-guard.js'
import { ok, valid, validJson } from '../http.js'
import {
  addMcpServer,
  auditMcp,
  cancelMcpSignIn,
  reconnectMcpServer,
  removeMcpServer,
  startMcpSignIn,
} from '../mcp-actions.js'
import { mcpAuth } from '../mcp-auth.js'
import { mcpCatalog, setMcpDefault } from '../mcp-selection.js'
import { noteSignedIn } from '../mcp-session-status.js'

const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const mcpRoutes = new Hono()
  .get('/selection', async (c) => ok(c, await mcpCatalog()))
  .put('/defaults/:name', valid('param', mcpDefaultParams), validJson(mcpDefaultInput), async (c) =>
    ok(c, await setMcpDefault(c.req.valid('param').name, c.req.valid('json').enabled)),
  )
  .post('/servers', validJson(mcpServerInput), async (c) => {
    const input = c.req.valid('json')
    if (fromEa() && (input.transport === 'stdio' || input.headers.length > 0)) {
      return refuseEa(c, 'add a server that runs a command or takes credential headers')
    }
    return ok(c, await addMcpServer(input))
  })
  .delete('/servers/:name', valid('param', mcpServerNameParam), valid('query', mcpServerRemoveQuery), async (c) => {
    const { scope, repo_id } = c.req.valid('query')
    return ok(c, await removeMcpServer(c.req.valid('param').name, scope, repo_id))
  })
  .post('/auth/:session_id/complete', notEa('finish an OAuth sign-in'), validJson(mcpAuthCompleteInput), async (c) => {
    const id = c.req.param('session_id')
    const server = mcpAuth.serverOf(id)
    try {
      const done = await mcpAuth.complete(id, c.req.valid('json').callback_url)
      await auditMcp('mcp.signin_completed', done.server, `Signed in to MCP server ${done.server}`)
      noteSignedIn()
      return ok(c, done)
    } catch (e) {
      const name = server ?? 'unknown server'
      await auditMcp('mcp.signin_failed', server, `Sign-in to ${name} failed: ${failureText(e)}`)
      throw e
    }
  })
  .delete('/auth/:session_id', async (c) => {
    await cancelMcpSignIn(c.req.param('session_id'))
    return c.body(null, 204)
  })
  .post('/:server/auth/start', validJson(mcpSignInInput), async (c) => {
    const { repo_id, task_id } = c.req.valid('json')
    return ok(c, await startMcpSignIn(c.req.param('server'), repo_id, task_id))
  })
  .post('/:server/reconnect', validJson(mcpScopeInput), async (c) =>
    ok(c, await reconnectMcpServer(c.req.param('server'), c.req.valid('json').repo_id)),
  )
