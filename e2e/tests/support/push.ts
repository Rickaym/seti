import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Page } from '@playwright/test'
import type { NotificationPayload } from '@seti/shared'

/** Lets the worker's Seti push to a loopback endpoint, which stands in for a push service. */
export const PUSH_ENV = { SETI_PUSH_LOOPBACK: '1' }

interface Push {
  headers: http.IncomingHttpHeaders
  payload: NotificationPayload
}

/** A browser's push keys, so the test can read what Seti encrypted to it. */
interface Keys {
  ecdh: ReturnType<typeof createECDH>
  auth: Buffer
}

/** Decrypts an aes128gcm push body (RFC 8291) the way the browser would. */
function decrypt(keys: Keys, body: Buffer): NotificationPayload {
  const salt = body.subarray(0, 16)
  const idLength = body.readUInt8(20)
  const serverKey = body.subarray(21, 21 + idLength)
  const sealed = body.subarray(21 + idLength)
  const shared = keys.ecdh.computeSecret(serverKey)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), keys.ecdh.getPublicKey(), serverKey])
  const ikm = Buffer.from(hkdfSync('sha256', shared, keys.auth, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(sealed.subarray(sealed.length - 16))
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()])
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')) as NotificationPayload
}

/** A local push service that keeps what Seti sends it, decrypted. */
export interface PushService {
  endpoint: string
  pushes: Push[]
  /** What the page's mocked PushManager hands Seti as its subscription keys. */
  keys: { p256dh: string; auth: string }
  close: () => Promise<void>
}

export async function startPushService(): Promise<PushService> {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const keys: Keys = { ecdh, auth: randomBytes(16) }
  const pushes: Push[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      pushes.push({ headers: req.headers, payload: decrypt(keys, Buffer.concat(chunks)) })
      res.writeHead(201).end()
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    endpoint: `http://127.0.0.1:${String(port)}/push/e2e`,
    pushes,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: keys.auth.toString('base64url') },
    close: async () =>
      new Promise((resolve) => {
        server.close(() => {
          resolve()
        })
      }),
  }
}

interface MockSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/** Stands in for the browser's push support: permission is granted and subscribing succeeds. */
function mockPush({ endpoint, p256dh, auth }: MockSubscription): void {
  let permission: NotificationPermission = 'default'
  let current: PushSubscription | null = null
  const subscription = (key: ArrayBuffer): PushSubscription =>
    ({
      endpoint,
      options: { applicationServerKey: key, userVisibleOnly: true },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
      unsubscribe: async () => {
        current = null
        return Promise.resolve(true)
      },
    }) as unknown as PushSubscription
  const pushManager = {
    getSubscription: async () => Promise.resolve(current),
    subscribe: async (options: PushSubscriptionOptionsInit) => {
      const key = options.applicationServerKey as Uint8Array
      current = subscription(key.slice().buffer)
      return Promise.resolve(current)
    },
  }
  const registration = { pushManager } as unknown as ServiceWorkerRegistration
  Object.defineProperty(Notification, 'permission', { get: () => permission })
  Notification.requestPermission = async () => {
    document.documentElement.dataset.permissionAsked = navigator.userActivation.isActive ? 'on-tap' : 'unprompted'
    permission = 'granted'
    return Promise.resolve(permission)
  }
  Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { get: async () => Promise.resolve(registration) })
  ServiceWorkerContainer.prototype.getRegistration = async () => Promise.resolve(registration)
}

export async function mockPushManager(page: Page, service: PushService): Promise<void> {
  await page.addInitScript(mockPush, { endpoint: service.endpoint, ...service.keys })
}
