import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Verdict } from './types.js'

export const hmacHex = (secret: string, body: Buffer | string) =>
  createHmac('sha256', secret).update(body).digest('hex')

export const sha256Hex = (body: Buffer | string) => createHash('sha256').update(body).digest('hex')

/** Compares digests of both sides, so neither the content nor the length leaks through timing. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

/** A header holding `<prefix><hex HMAC-SHA256 of the body>`. */
export function verifyHmac(header: string | null, prefix: string, body: Buffer, secret: string): Verdict {
  if (header === null || header.trim() === '') {
    return { ok: false, reason: 'missing signature' }
  }
  const value = header.trim()
  const expected = `${prefix}${hmacHex(secret, body)}`
  return safeEqual(value.toLowerCase(), expected) ? { ok: true } : { ok: false, reason: 'signature mismatch' }
}

/** A secret Seti issues: 256 random bits, prefixed so the credential scrubber recognises it. */
export const newSecret = () => `whsec_${randomBytes(32).toString('base64url')}`

/** The unguessable id in a webhook's path: 144 random bits. */
export const newHookId = () => randomBytes(18).toString('base64url')

export const HOOK_ID = /^[\w-]{24}$/
