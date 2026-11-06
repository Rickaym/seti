import { createPrivateKey, type KeyObject } from 'node:crypto'

/** A key or key file Seti cannot sign with; the message never holds the key. */
export class KeyError extends Error {}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

export function algorithmOf(key: KeyObject): 'RS256' | 'ES256' {
  if (key.asymmetricKeyType === 'rsa') {
    return 'RS256'
  }
  if (key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1') {
    return 'ES256'
  }
  throw new KeyError('The private key must be RSA or EC P-256')
}

export function privateKey(pem: string): KeyObject {
  try {
    return createPrivateKey(pem)
  } catch {
    throw new KeyError('The private key is not a PEM private key')
  }
}

/** Entra shows certificate thumbprints as hex; x5t wants the SHA-1 bytes as base64url. */
export const x5t = (thumbprint: string) =>
  /^[0-9a-f]{40}$/i.test(thumbprint.replace(/[:\s]/g, ''))
    ? Buffer.from(thumbprint.replace(/[:\s]/g, ''), 'hex').toString('base64url')
    : thumbprint

interface ServiceAccount {
  clientEmail: string
  privateKey: string
  keyId: string | null
}

export function serviceAccount(json: string): ServiceAccount {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new KeyError('The key file is not JSON')
  }
  const clientEmail = isObject(parsed) ? text(parsed.client_email) : null
  const key = isObject(parsed) ? text(parsed.private_key) : null
  if (clientEmail === null || key === null || !isObject(parsed)) {
    throw new KeyError('The service account key file has no client_email or private_key')
  }
  return { clientEmail, privateKey: key, keyId: text(parsed.private_key_id) }
}

/** Why a pasted key file cannot sign token requests, or null when it can. */
export function keyFileProblem(json: string): string | null {
  try {
    privateKey(serviceAccount(json).privateKey)
    return null
  } catch (e) {
    return e instanceof KeyError ? e.message : 'The key file cannot be read'
  }
}
