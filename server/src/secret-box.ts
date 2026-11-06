import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const PREFIX = 'seti1'

/** The value was sealed under a different key than the one Seti has now. */
export class WrongKeyError extends Error {}

/** The value does not decrypt: it was changed, truncated, or moved to another name. */
export class TamperedError extends Error {}

export interface SecretBox {
  /** First bytes of the key's SHA-256, stored with each value to tell a wrong key from tampering. */
  keyId: string
  seal: (plaintext: string, context: string) => string
  open: (sealed: string, context: string) => string
}

export const isSealed = (value: string) => value.startsWith(`${PREFIX}:`)

/** Parses a base64 key of exactly 32 bytes. */
export function parseKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), 'base64')
  if (key.length !== KEY_BYTES) {
    throw new Error(`The secret store key must be ${String(KEY_BYTES)} bytes in base64, not ${String(key.length)}`)
  }
  return key
}

/** AES-256-GCM with a random nonce per value; `context` is authenticated but never stored. */
export function secretBox(key: Buffer): SecretBox {
  if (key.length !== KEY_BYTES) {
    throw new Error(`The secret store key must be ${String(KEY_BYTES)} bytes`)
  }
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 8)
  return {
    keyId,
    seal: (plaintext, context) => {
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES })
      cipher.setAAD(Buffer.from(context, 'utf8'))
      const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const parts = [iv, body, cipher.getAuthTag()].map((part) => part.toString('base64url'))
      return [PREFIX, keyId, ...parts].join(':')
    },
    open: (sealed, context) => {
      const [prefix, id, iv, body, tag, ...rest] = sealed.split(':')
      if (prefix !== PREFIX || id === undefined || iv === undefined || body === undefined || tag === undefined) {
        throw new TamperedError('The stored value is not a sealed secret')
      }
      if (rest.length > 0) {
        throw new TamperedError('The stored value is not a sealed secret')
      }
      if (id !== keyId) {
        throw new WrongKeyError(`The value was sealed with key ${id}, and Seti has key ${keyId}`)
      }
      try {
        const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'), {
          authTagLength: TAG_BYTES,
        })
        decipher.setAAD(Buffer.from(context, 'utf8'))
        decipher.setAuthTag(Buffer.from(tag, 'base64url'))
        return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8')
      } catch {
        throw new TamperedError('The stored value failed its integrity check')
      }
    },
  }
}
