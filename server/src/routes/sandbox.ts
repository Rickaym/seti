import { sandboxPolicyInput } from '@seti/shared'
import { Hono } from 'hono'
import { eaReadOnly } from '../ea-guard.js'
import { ok, validJson } from '../http.js'
import { saveSandboxPolicy } from '../sandbox-policy.js'
import { sandboxStatus } from '../sandbox-status.js'

/** The task sandbox setting, the credentials its proxy uses, and what every task hides. */
export const sandboxRoutes = new Hono()
  .use('*', eaReadOnly('change the sandbox'))
  .get('/', async (c) => ok(c, await sandboxStatus()))
  .put('/', validJson(sandboxPolicyInput), async (c) =>
    ok(c, await sandboxStatus(await saveSandboxPolicy(c.req.valid('json')))),
  )
