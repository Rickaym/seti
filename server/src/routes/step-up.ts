import { signInInput } from '@seti/shared'
import { Hono, type Context } from 'hono'
import { currentPublicHost, currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import { notEa } from '../ea-guard.js'
import { fail, HttpError, ok, validJson } from '../http.js'
import { SignInFailure, stepUpOptions, verifyStepUp } from '../passkeys.js'
import { clientKey, rateLimiter } from '../rate-limit.js'
import { relyingParty } from '../relying-party.js'
import { sessionRows } from '../store/auth.js'

/** Passkey checks per client per ten minutes. */
const perClient = rateLimiter(20, 10 * 60_000)

function sessionOf(): string {
  const source = currentRequestSource()
  if (source?.via !== 'session') {
    throw new HttpError(400, 'A passkey check needs a browser signed in with a passkey')
  }
  return source.sessionId
}

const limited = (c: Context) =>
  perClient.take(clientKey(c, currentPublicHost() !== null))
    ? null
    : fail(c, 429, 'Too many attempts', 'Too many passkey checks; wait a few minutes and try again')

/** A fresh passkey check inside a signed-in session, which installing and granting mods ask for. */
export const stepUpRoutes = new Hono()
  .use('*', notEa('confirm with a passkey'))
  .post('/options', async (c) => limited(c) ?? ok(c, await stepUpOptions(relyingParty(c), sessionOf())))
  .post('/', validJson(signInInput), async (c) => {
    const refusal = limited(c)
    if (refusal !== null) {
      return refusal
    }
    const session = sessionOf()
    const rp = relyingParty(c)
    try {
      const row = await verifyStepUp(c.req.valid('json'), rp, session)
      const at = new Date().toISOString()
      await sessionRows.steppedUp(session, at)
      await audit.record({
        actor: 'user',
        kind: 'system.stepped_up',
        subject_type: 'system',
        subject_id: session,
        summary: `Confirmed with the passkey "${row.name}" on ${rp.id}`,
        detail: { passkey: row.name, host: rp.id },
      })
      return ok(c, { stepped_up_at: at })
    } catch (e) {
      if (e instanceof SignInFailure) {
        return fail(c, 403, 'Passkey check failed', 'That passkey did not confirm it is you')
      }
      throw e
    }
  })
