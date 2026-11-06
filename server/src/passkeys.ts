import { randomBytes, randomUUID } from 'node:crypto'
import type { PasskeyRegisterInput, SignInInput } from '@seti/shared'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { HttpError } from './http.js'
import { authSettingsRows, passkeyRows, type PasskeyRow } from './store/auth.js'

/** The site a passkey belongs to: its WebAuthn relying party id and the origin that uses it. */
export interface RelyingParty {
  id: string
  origin: string
}

type CeremonyKind = 'register' | 'setup' | 'signin' | 'stepup'

interface Ceremony {
  kind: CeremonyKind
  challenge: string
  rp: RelyingParty
  expires: number
  /** The setup code a setup ceremony was opened with, hashed; it is used up on finishing. */
  setupHash: string | null
  /** The session a step-up ceremony belongs to; only that session can finish it. */
  session?: string
}

const CEREMONY_MS = 5 * 60_000
const CEREMONIES_MAX = 500
/** ES256 and RS256, what platform authenticators and security keys use. */
const ALGORITHMS = [-7, -257]

const ceremonies = new Map<string, Ceremony>()

function openCeremony(ceremony: Omit<Ceremony, 'expires'>): string {
  const now = Date.now()
  for (const [id, open] of ceremonies) {
    if (open.expires <= now) {
      ceremonies.delete(id)
    }
  }
  while (ceremonies.size >= CEREMONIES_MAX) {
    const oldest = ceremonies.keys().next().value
    if (oldest === undefined) {
      break
    }
    ceremonies.delete(oldest)
  }
  const id = randomBytes(18).toString('base64url')
  ceremonies.set(id, { ...ceremony, expires: now + CEREMONY_MS })
  return id
}

const STALE = 'This passkey request expired or was already used; start again'

/** Takes a ceremony out for its one answer, refusing another kind or another site. */
function takeCeremony(id: string, kind: CeremonyKind, rp: RelyingParty): Ceremony {
  const ceremony = ceremonies.get(id)
  ceremonies.delete(id)
  if (
    ceremony?.kind !== kind ||
    ceremony.expires <= Date.now() ||
    ceremony.rp.id !== rp.id ||
    ceremony.rp.origin !== rp.origin
  ) {
    throw new HttpError(400, STALE)
  }
  return ceremony
}

type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> }

/** Drops keys whose value is undefined, as optional WebAuthn fields must be absent, not undefined. */
const defined = <T extends object>(value: T): Defined<T> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Defined<T>

function registrationJson(input: PasskeyRegisterInput['response']): RegistrationResponseJSON {
  const { response, ...credential } = input
  return { ...defined(credential), response: defined(response), clientExtensionResults: {} }
}

function authenticationJson(input: SignInInput['response']): AuthenticationResponseJSON {
  const { response, ...credential } = input
  return { ...defined(credential), response: defined(response), clientExtensionResults: {} }
}

const transportsOf = (row: Pick<PasskeyRow, 'transports'>): string[] => {
  const parsed: unknown = JSON.parse(row.transports)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

/** Starts enrolling a passkey for `rp`; a setup ceremony carries the setup code it began with. */
export async function registrationOptions(
  rp: RelyingParty,
  kind: 'register' | 'setup',
  setupHash: string | null = null,
): Promise<{ ceremony: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  const settings = await authSettingsRows.get(new Date().toISOString())
  const existing = (await passkeyRows.list()).filter((row) => row.rp_id === rp.id)
  const options = await generateRegistrationOptions({
    rpName: 'Seti',
    rpID: rp.id,
    userName: 'seti',
    userDisplayName: 'Seti',
    userID: Buffer.from(settings.user_handle, 'base64url'),
    attestationType: 'none',
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: transportsOf(row) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    supportedAlgorithmIDs: ALGORITHMS,
  })
  return { ceremony: openCeremony({ kind, challenge: options.challenge, rp, setupHash }), options }
}

/** The setup code hash a setup ceremony was opened with, read before the ceremony is finished. */
export function ceremonySetupHash(id: string): string | null {
  return ceremonies.get(id)?.setupHash ?? null
}

/** Checks the authenticator's answer and stores the new passkey. */
export async function registerPasskey(
  input: PasskeyRegisterInput,
  rp: RelyingParty,
  kind: 'register' | 'setup',
  at: Date = new Date(),
): Promise<PasskeyRow> {
  const ceremony = takeCeremony(input.ceremony, kind, rp)
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>
  try {
    verification = await verifyRegistrationResponse({
      response: registrationJson(input.response),
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      requireUserVerification: true,
      supportedAlgorithmIDs: ALGORITHMS,
    })
  } catch (e) {
    throw new HttpError(400, `The passkey could not be verified: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!verification.verified) {
    throw new HttpError(400, 'The passkey could not be verified')
  }
  const { credential, credentialDeviceType } = verification.registrationInfo
  if ((await passkeyRows.byCredential(credential.id)) !== undefined) {
    throw new HttpError(409, 'This passkey is already enrolled')
  }
  const row: PasskeyRow = {
    id: randomUUID(),
    credential_id: credential.id,
    public_key: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: JSON.stringify(credential.transports ?? input.response.response.transports ?? []),
    rp_id: rp.id,
    name: input.name,
    synced: credentialDeviceType === 'multiDevice',
    created_at: at.toISOString(),
    last_used_at: null,
  }
  await passkeyRows.insert(row)
  return row
}

export async function signInOptions(
  rp: RelyingParty,
): Promise<{ ceremony: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' })
  return { ceremony: openCeremony({ kind: 'signin', challenge: options.challenge, rp, setupHash: null }), options }
}

/** Why a sign-in failed, for the audit log; the browser hears only that it failed. */
export class SignInFailure extends Error {}

/** The passkey that answered the sign-in challenge, its counter moved on. */
export async function verifySignIn(input: SignInInput, rp: RelyingParty, at: Date = new Date()): Promise<PasskeyRow> {
  let ceremony: Ceremony
  try {
    ceremony = takeCeremony(input.ceremony, 'signin', rp)
  } catch {
    throw new SignInFailure('stale ceremony')
  }
  return verifyAssertion(ceremony, input, rp, at)
}

/** A fresh passkey check for a session already signed in, as consent to mods asks for. */
export async function stepUpOptions(
  rp: RelyingParty,
  session: string,
): Promise<{ ceremony: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const options = await generateAuthenticationOptions({ rpID: rp.id, userVerification: 'required' })
  const ceremony = openCeremony({ kind: 'stepup', challenge: options.challenge, rp, setupHash: null, session })
  return { ceremony, options }
}

/** The passkey that answered a step-up, which only the session that asked for it can finish. */
export async function verifyStepUp(
  input: SignInInput,
  rp: RelyingParty,
  session: string,
  at: Date = new Date(),
): Promise<PasskeyRow> {
  let ceremony: Ceremony
  try {
    ceremony = takeCeremony(input.ceremony, 'stepup', rp)
  } catch {
    throw new SignInFailure('stale ceremony')
  }
  if (ceremony.session !== session) {
    throw new SignInFailure('another session asked for this check')
  }
  return verifyAssertion(ceremony, input, rp, at)
}

async function verifyAssertion(
  ceremony: Ceremony,
  input: SignInInput,
  rp: RelyingParty,
  at: Date,
): Promise<PasskeyRow> {
  const row = await passkeyRows.byCredential(input.response.id)
  if (row?.rp_id !== rp.id) {
    throw new SignInFailure('unknown passkey')
  }
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: authenticationJson(input.response),
      expectedChallenge: ceremony.challenge,
      expectedOrigin: rp.origin,
      expectedRPID: rp.id,
      credential: {
        id: row.credential_id,
        publicKey: Buffer.from(row.public_key, 'base64url'),
        counter: row.counter,
        transports: transportsOf(row),
      },
      requireUserVerification: true,
    })
    if (!verified) {
      throw new SignInFailure('signature not verified')
    }
    await passkeyRows.used(row.id, authenticationInfo.newCounter, at.toISOString())
    return row
  } catch (e) {
    if (e instanceof SignInFailure) {
      throw e
    }
    throw new SignInFailure(e instanceof Error ? e.message : String(e))
  }
}
