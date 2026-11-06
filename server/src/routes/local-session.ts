import { localSessionInput, type LocalSession } from '@seti/shared'
import { Hono } from 'hono'
import { currentPublicHost } from '../access.js'
import { audit } from '../audit.js'
import { notEa } from '../ea-guard.js'
import { fail, ok, validJson } from '../http.js'
import type { LocalAuth } from '../local-auth.js'

/** Signs a local browser in with the user's local token, into an HttpOnly session cookie. */
export function localSessionRoutes(local: LocalAuth): Hono {
  return new Hono()
    .use('*', notEa('sign browsers in or out'))
    .post('/', validJson(localSessionInput), async (c) => {
      if (currentPublicHost() !== null) {
        return fail(c, 400, 'Not here', 'The local token signs in only on loopback; use a passkey here')
      }
      const signedIn = local.caller(c.req.valid('json').token) === 'user'
      await audit.record({
        actor: 'user',
        kind: 'system.local_signin',
        subject_type: 'system',
        summary: signedIn ? 'Signed in a local browser' : 'Refused a local sign-in with a wrong token',
        detail: { ok: signedIn },
      })
      if (!signedIn) {
        return fail(c, 401, 'Wrong token', 'That is not the local token of this Seti')
      }
      local.startSession(c)
      return ok(c, { required: false } satisfies LocalSession)
    })
    .delete('/', (c) => {
      local.endSession(c)
      return ok(c, { required: true } satisfies LocalSession)
    })
}
