import { z } from 'zod'

/** How a browser is signed in: a passkey session, the local token, or Cloudflare Access. */
export type SignInMethod = 'passkey' | 'local' | 'access'

/** What the sign-in page needs to know; anyone may read it, so it holds nothing secret. */
export interface AuthState {
  signed_in: boolean
  method: SignInMethod | null
  /** A passkey can sign in here: one is enrolled for this host's relying party. */
  passkeys: boolean
  /** This request came over loopback, where the local token signs a browser in. */
  local: boolean
}

/** Seti's own sign-in as Settings shows it. */
export interface AuthSettings {
  /** Requests on the public host need a passkey session, whatever Cloudflare Access let through. */
  enforced: boolean
  /** True when Cloudflare Access guards the public host; without it Seti's sign-in always applies. */
  cloudflare_access: boolean
  /** The public hostname passkeys for phones and other machines belong to; null on loopback only. */
  public_host: string | null
  /** Why enforcement cannot be turned on yet; null when it can. */
  enforce_blocked: string | null
}

export interface PasskeyInfo {
  id: string
  name: string
  /** The host the passkey signs in to, its WebAuthn relying party. */
  rp_id: string
  /** Synced passkeys live in a password manager; device-bound ones on one authenticator. */
  synced: boolean
  created_at: string
  last_used_at: string | null
}

export interface AuthSessionInfo {
  id: string
  passkey_name: string | null
  host: string
  user_agent: string
  ip: string | null
  created_at: string
  last_seen_at: string
  expires_at: string
  /** The session of the browser asking. */
  current: boolean
}

export const PASSKEY_NAME_MAX = 60

export const passkeyNameInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Type a name')
    .max(PASSKEY_NAME_MAX, `Keep it under ${String(PASSKEY_NAME_MAX)} characters`),
})
export type PasskeyNameInput = z.input<typeof passkeyNameInput>

export const enforcementInput = z.object({ enforced: z.boolean() })
export type EnforcementInput = z.input<typeof enforcementInput>

/** A one-time code from `pnpm setup-code` on the host, in groups; case and dashes are free. */
export const setupCodeInput = z.object({ code: z.string().trim().min(1, 'Type the setup code').max(64) })
export type SetupCodeInput = z.input<typeof setupCodeInput>

/** Upper case, without separators, so a code reads the same however it was typed. */
export const normalizeSetupCode = (code: string) => code.replace(/[\s-]/g, '').toUpperCase()

const B64URL = z
  .string()
  .max(16 * 1024)
  .regex(/^[A-Za-z0-9_-]*$/, 'Expected base64url')

const TRANSPORTS = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'] as const

const credentialBase = {
  id: B64URL.min(1),
  rawId: B64URL.min(1),
  type: z.literal('public-key'),
  authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
}

/** What @simplewebauthn/browser's startRegistration returns. */
export const registrationResponse = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: B64URL,
    attestationObject: B64URL,
    authenticatorData: B64URL.optional(),
    transports: z.array(z.enum(TRANSPORTS)).max(TRANSPORTS.length).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: B64URL.optional(),
  }),
})

/** What @simplewebauthn/browser's startAuthentication returns. */
export const authenticationResponse = z.object({
  ...credentialBase,
  response: z.object({
    clientDataJSON: B64URL,
    authenticatorData: B64URL,
    signature: B64URL,
    userHandle: B64URL.optional(),
  }),
})

/** Names one ceremony the server started, so its challenge is checked once and then dropped. */
const ceremony = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Unknown ceremony')

export const passkeyRegisterInput = z.object({
  ceremony,
  name: passkeyNameInput.shape.name,
  response: registrationResponse,
})
export type PasskeyRegisterInput = z.input<typeof passkeyRegisterInput>

export const signInInput = z.object({ ceremony, response: authenticationResponse })
export type SignInInput = z.input<typeof signInInput>

/** Options for the browser's WebAuthn call, with the ceremony to send back with its answer. */
export interface CeremonyStart<Options> {
  ceremony: string
  options: Options
}
