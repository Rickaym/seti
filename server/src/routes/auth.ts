import {
  enforcementInput,
  passkeyNameInput,
  passkeyRegisterInput,
  setupCodeInput,
  signInInput,
  type AuditDetail,
  type AuthSessionInfo,
  type AuthSettings,
  type AuthState,
  type PasskeyInfo,
  type SignInMethod,
} from '@seti/shared'
import { Hono, type Context } from 'hono'
import { currentPublicHost, currentRequestSource } from '../access.js'
import { audit } from '../audit.js'
import type { PublicAccess } from '../config.js'
import { notEa } from '../ea-guard.js'
import { fail, HttpError, ok, validJson } from '../http.js'
import {
  ceremonySetupHash,
  registerPasskey,
  registrationOptions,
  signInOptions,
  SignInFailure,
  verifySignIn,
} from '../passkeys.js'
import { clientAddress, clientKey, mayAuditRefusal, rateLimiter } from '../rate-limit.js'
import { hostnameOf, relyingParty } from '../relying-party.js'
import {
  authEnforced,
  consumeSetupCode,
  endSession,
  liveSessions,
  revokeSession,
  setupCodeHash,
  setupCodeValid,
  startSession,
  storeEnforced,
} from '../seti-auth.js'
import { passkeyRows, type PasskeyRow } from '../store/auth.js'

const WINDOW_MS = 10 * 60_000
/** Sign-in and setup attempts per client per ten minutes; no shared cap anyone could drain. */
const perClient = rateLimiter(20, WINDOW_MS)

function limited(c: Context): Response | null {
  const key = clientKey(c, currentPublicHost() !== null)
  if (perClient.take(key)) {
    return null
  }
  return fail(c, 429, 'Too many attempts', 'Too many sign-in attempts; wait a few minutes and try again')
}

const secure = () => currentPublicHost() !== null

const clientIp = (c: Context) => (secure() ? clientAddress(c) : null)

/** Records a refused attempt, at most a few per client, so a flood cannot fill the audit log. */
async function auditRefusal(c: Context, summary: string, detail: AuditDetail): Promise<void> {
  if (!mayAuditRefusal(clientKey(c, secure()))) {
    return
  }
  await audit.record({ actor: 'user', kind: 'system.signin_failed', subject_type: 'system', summary, detail })
}

function methodOf(): SignInMethod | null {
  switch (currentRequestSource()?.via) {
    case 'session':
      return 'passkey'
    case 'local':
      return 'local'
    case 'public':
      return 'access'
    case 'ea':
    case 'agent':
    case 'device':
    case 'mod':
    case undefined:
      return null
  }
}

async function stateOf(c: Context, signedIn: SignInMethod | null = methodOf()): Promise<AuthState> {
  const rpId = currentPublicHost()?.hostname ?? hostnameOf(c)
  return {
    signed_in: signedIn !== null,
    method: signedIn,
    passkeys: (await passkeyRows.countFor(rpId)) > 0,
    local: currentPublicHost() === null,
  }
}

const passkeyInfo = (row: PasskeyRow): PasskeyInfo => ({
  id: row.id,
  name: row.name,
  rp_id: row.rp_id,
  synced: row.synced,
  created_at: row.created_at,
  last_used_at: row.last_used_at,
})

/** Signs this browser in with the passkey it just used or enrolled. */
async function signInWith(c: Context, row: PasskeyRow): Promise<void> {
  const host = currentPublicHost()?.hostname ?? hostnameOf(c)
  await startSession(c, { passkeyId: row.id, host, secure: secure(), ip: clientIp(c) })
  await audit.record({
    actor: 'user',
    kind: 'system.signin',
    subject_type: 'system',
    subject_id: row.id,
    summary: `Signed in with the passkey "${row.name}" on ${host}`,
    detail: { passkey: row.name, host, ip: clientIp(c) },
  })
}

async function recordAdded(row: PasskeyRow, how: string): Promise<void> {
  await audit.record({
    actor: 'user',
    kind: 'system.passkey_added',
    subject_type: 'system',
    subject_id: row.id,
    summary: `Added the passkey "${row.name}" for ${row.rp_id}${how}`,
    detail: { name: row.name, rp_id: row.rp_id, synced: row.synced },
  })
}

/** Why enforcement cannot be turned on: no public host, or no passkey that signs in to it. */
async function enforceBlocked(access: PublicAccess | null): Promise<string | null> {
  if (access === null) {
    return 'Seti has no public hostname; loopback always takes the local token'
  }
  if ((await passkeyRows.countFor(access.hostname)) === 0) {
    return `Add a passkey on ${access.hostname} first, so you can still sign in there`
  }
  return null
}

async function settingsOf(access: PublicAccess | null): Promise<AuthSettings> {
  return {
    enforced: await authEnforced(),
    cloudflare_access: (access?.cloudflare ?? null) !== null,
    public_host: access?.hostname ?? null,
    enforce_blocked: await enforceBlocked(access),
  }
}

/** The public host while only a passkey opens it, which must keep at least one; else null. */
async function gatedHost(access: PublicAccess | null): Promise<string | null> {
  if (access === null) {
    return null
  }
  return access.cloudflare === null || (await authEnforced()) ? access.hostname : null
}

async function passkeyOf(c: Context): Promise<PasskeyRow> {
  const row = await passkeyRows.get(c.req.param('id') ?? '')
  if (row === undefined) {
    throw new HttpError(404, 'No such passkey')
  }
  return row
}

const currentSessionId = () => {
  const source = currentRequestSource()
  return source?.via === 'session' ? source.sessionId : null
}

/** Seti's own sign-in: passkeys, browser sessions, host setup codes and the enforcement switch. */
export function authRoutes(access: PublicAccess | null): Hono {
  return new Hono()
    .use('*', notEa('change sign-in, passkeys or sessions'))
    .get('/', async (c) => ok(c, await stateOf(c)))
    .post('/signin/options', async (c) => limited(c) ?? ok(c, await signInOptions(relyingParty(c))))
    .post('/signin', validJson(signInInput), async (c) => {
      const refusal = limited(c)
      if (refusal !== null) {
        return refusal
      }
      const rp = relyingParty(c)
      let row: PasskeyRow
      try {
        row = await verifySignIn(c.req.valid('json'), rp)
      } catch (e) {
        if (!(e instanceof SignInFailure)) {
          throw e
        }
        await auditRefusal(c, `Refused a passkey sign-in on ${rp.id}: ${e.message}`, {
          host: rp.id,
          ip: clientIp(c),
          reason: e.message,
        })
        return fail(c, 401, 'Sign-in failed', 'That passkey did not sign in to this Seti')
      }
      await signInWith(c, row)
      return ok(c, await stateOf(c, 'passkey'))
    })
    .post('/setup/options', validJson(setupCodeInput), async (c) => {
      const refusal = limited(c)
      if (refusal !== null) {
        return refusal
      }
      const { code } = c.req.valid('json')
      if (!(await setupCodeValid(code))) {
        await auditRefusal(c, 'Refused a setup code that was wrong, used or expired', {
          ip: clientIp(c),
          reason: 'bad setup code',
        })
        return fail(c, 401, 'Wrong code', 'That setup code is wrong, used or expired; make a new one on the host')
      }
      return ok(c, await registrationOptions(relyingParty(c), 'setup', setupCodeHash(code)))
    })
    .post('/setup', validJson(passkeyRegisterInput), async (c) => {
      const refusal = limited(c)
      if (refusal !== null) {
        return refusal
      }
      const input = c.req.valid('json')
      const hash = ceremonySetupHash(input.ceremony)
      if (hash === null || !(await consumeSetupCode(hash))) {
        await auditRefusal(c, 'Refused a passkey setup whose code expired or was used', {
          ip: clientIp(c),
          reason: 'setup code gone',
        })
        return fail(c, 401, 'Wrong code', 'That setup code expired or was used; make a new one on the host')
      }
      const row = await registerPasskey(input, relyingParty(c), 'setup')
      await recordAdded(row, ' with a setup code')
      await signInWith(c, row)
      return ok(c, await stateOf(c, 'passkey'))
    })
    .post('/signout', async (c) => {
      const sessionId = currentSessionId()
      await endSession(c, secure())
      if (sessionId !== null) {
        await audit.record({
          actor: 'user',
          kind: 'system.signout',
          subject_type: 'system',
          subject_id: sessionId,
          summary: 'Signed out a passkey session',
        })
      }
      return ok(c, await stateOf(c, null))
    })
    .get('/settings', async (c) => ok(c, await settingsOf(access)))
    .put('/enforcement', validJson(enforcementInput), async (c) => {
      const { enforced } = c.req.valid('json')
      const blocked = enforced ? await enforceBlocked(access) : null
      if (blocked !== null) {
        return fail(c, 409, 'Not yet', blocked)
      }
      await storeEnforced(enforced)
      await audit.record({
        actor: 'user',
        kind: 'system.auth_enforcement_changed',
        subject_type: 'system',
        summary: enforced ? 'Required passkey sign-in on the public host' : 'Let Cloudflare Access sign browsers in',
        detail: { enforced },
      })
      return ok(c, await settingsOf(access))
    })
    .get('/passkeys', async (c) => ok(c, (await passkeyRows.list()).map(passkeyInfo)))
    .post('/passkeys/options', async (c) => ok(c, await registrationOptions(relyingParty(c), 'register')))
    .post('/passkeys', validJson(passkeyRegisterInput), async (c) => {
      const row = await registerPasskey(c.req.valid('json'), relyingParty(c), 'register')
      await recordAdded(row, '')
      if (currentSessionId() === null) {
        await signInWith(c, row)
      }
      return ok(c, passkeyInfo(row))
    })
    .patch('/passkeys/:id', validJson(passkeyNameInput), async (c) => {
      const row = await passkeyOf(c)
      const { name } = c.req.valid('json')
      await passkeyRows.rename(row.id, name)
      await audit.record({
        actor: 'user',
        kind: 'system.passkey_renamed',
        subject_type: 'system',
        subject_id: row.id,
        summary: `Renamed the passkey "${row.name}" to "${name}"`,
        detail: { name, previous_name: row.name },
      })
      return ok(c, passkeyInfo({ ...row, name }))
    })
    .delete('/passkeys/:id', async (c) => {
      const row = await passkeyOf(c)
      const outcome = await passkeyRows.deleteUnlessLast(row.id, await gatedHost(access))
      if (outcome === 'last') {
        return fail(
          c,
          409,
          'Last passkey',
          `This is the last passkey for ${row.rp_id}, which needs one to sign in; add another first`,
        )
      }
      if (outcome === 'missing') {
        throw new HttpError(404, 'No such passkey')
      }
      await audit.record({
        actor: 'user',
        kind: 'system.passkey_removed',
        subject_type: 'system',
        subject_id: row.id,
        summary: `Removed the passkey "${row.name}" and signed out its sessions`,
        detail: { name: row.name, rp_id: row.rp_id },
      })
      return ok(c, { removed: true })
    })
    .get('/sessions', async (c) => {
      const current = currentSessionId()
      const rows = await liveSessions()
      return ok(
        c,
        rows.map((row): AuthSessionInfo => ({
          id: row.id,
          passkey_name: row.passkey_name,
          host: row.host,
          user_agent: row.user_agent,
          ip: row.ip,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          expires_at: row.expires_at,
          current: row.id === current,
        })),
      )
    })
    .delete('/sessions/:id', async (c) => {
      const id = c.req.param('id')
      const removed = (await liveSessions()).find((row) => row.id === id)
      if (removed === undefined || !(await revokeSession(removed.id))) {
        throw new HttpError(404, 'No such session')
      }
      await audit.record({
        actor: 'user',
        kind: 'system.session_revoked',
        subject_type: 'system',
        subject_id: removed.id,
        summary: `Signed out a session on ${removed.host}`,
        detail: { host: removed.host, passkey: removed.passkey_name },
      })
      return ok(c, { removed: true })
    })
}
