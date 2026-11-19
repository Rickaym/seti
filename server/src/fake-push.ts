import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import type { NotificationPayload } from '@seti/shared'

/** A browser's push keys, kept so the test can read what Seti encrypted to it. */
export interface Browser {
  id: string
  endpoint: string
  ecdh: ReturnType<typeof createECDH>
  auth: Buffer
}

let browsers = 0

export function browser(host = 'fcm.googleapis.com'): Browser {
  browsers += 1
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    id: `device-${String(browsers).padStart(4, '0')}`,
    endpoint: `https://${host}/fcm/send/${String(browsers)}`,
    ecdh,
    auth: randomBytes(16),
  }
}

export const subscription = (b: Browser) => ({
  endpoint: b.endpoint,
  keys: { p256dh: b.ecdh.getPublicKey().toString('base64url'), auth: b.auth.toString('base64url') },
})

/** Decrypts an aes128gcm push body (RFC 8291) the way the browser would. */
export function decrypt(b: Browser, body: Buffer): NotificationPayload {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const serverKey = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const shared = b.ecdh.computeSecret(serverKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), b.ecdh.getPublicKey(), serverKey])
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')) as NotificationPayload
}
