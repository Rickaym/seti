import { STEP_UP_REFUSAL, type AuthState, type CeremonyStart, type PasskeyInfo } from '@seti/shared'
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser'
import { apiPost, RequestError } from '@/api'
import { deviceLabel } from '@/lib/device'

/** WebAuthn needs a secure context and a domain name; an address such as 127.0.0.1 has none. */
export const passkeysWork = () =>
  window.isSecureContext && browserSupportsWebAuthn() && !/^[\d.]+$|^\[/.test(window.location.hostname)

/** A starting name for a new passkey, such as Safari on iPhone. */
export const defaultPasskeyName = () => deviceLabel(navigator.userAgent)

export async function signInWithPasskey(): Promise<AuthState> {
  const start = await apiPost<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>>('/auth/signin/options', {})
  const response = await startAuthentication({ optionsJSON: start.options })
  return apiPost<AuthState>('/auth/signin', { ceremony: start.ceremony, response })
}

export async function addPasskey(name: string): Promise<PasskeyInfo> {
  const start = await apiPost<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>('/auth/passkeys/options', {})
  const response = await startRegistration({ optionsJSON: start.options })
  return apiPost<PasskeyInfo>('/auth/passkeys', { ceremony: start.ceremony, name, response })
}

/** Enrolls this browser's first passkey with a setup code made on the host, and signs it in. */
export async function setUpPasskey(code: string): Promise<AuthState> {
  const start = await apiPost<CeremonyStart<PublicKeyCredentialCreationOptionsJSON>>('/auth/setup/options', { code })
  const response = await startRegistration({ optionsJSON: start.options })
  return apiPost<AuthState>('/auth/setup', { ceremony: start.ceremony, name: defaultPasskeyName(), response })
}

/** Confirms with a passkey inside this session, as consent to mods asks with Require passkey on. */
async function stepUp(): Promise<void> {
  const start = await apiPost<CeremonyStart<PublicKeyCredentialRequestOptionsJSON>>('/auth/step-up/options', {})
  const response = await startAuthentication({ optionsJSON: start.options })
  await apiPost('/auth/step-up', { ceremony: start.ceremony, response })
}

/** Runs a consent call; when Seti asks for a fresh passkey check, confirms and runs it once more. */
export async function withStepUp<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!(e instanceof RequestError && e.status === 403 && e.message === STEP_UP_REFUSAL)) {
      throw e
    }
    await stepUp()
    return call()
  }
}
