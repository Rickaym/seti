import { createHash, createPublicKey, randomBytes, randomUUID, type KeyObject } from 'node:crypto'
import {
  DEVICE_AUTH_SCHEME,
  DEVICE_PLATFORMS,
  DEVICE_PROOF_MAX_AGE_S,
  DEVICE_PROOF_TYPE,
  DEVICE_SCOPES,
  OFFICIAL_ANDROID_APP,
  PAIRING_CODE_TTL_S,
  type AndroidApp,
  type AndroidAppSettings,
  type DeviceInfo,
  type DevicePairInput,
  type DeviceScope,
} from '@seti/shared'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import { ANDROID_OVERRIDE } from './config.js'
import { HttpError } from './http.js'
import { cache } from './redis.js'
import { androidAppRows, deviceRows, pairingCodeRows, type DeviceRow } from './store/devices.js'

const hash = (value: string) => createHash('sha256').update(value).digest('base64url')

/** Seen times are written at most this often, so a busy widget does not write on each request. */
const SEEN_EVERY_MS = 60_000
/** A jti is remembered past the proof's whole window on either side of the clock. */
const JTI_TTL_MS = 2 * DEVICE_PROOF_MAX_AGE_S * 1000 + 10_000
const JTI = /^[A-Za-z0-9_-]{16,128}$/
const DEVICE_SCOPE_SET: ReadonlySet<string> = new Set(DEVICE_SCOPES)

/** A one-time pairing code: 128 random bits, valid for five minutes. */
export async function createPairingCode(at: Date = new Date()): Promise<{ code: string; expires_at: string }> {
  const code = randomBytes(16).toString('base64url')
  const expires = new Date(at.getTime() + PAIRING_CODE_TTL_S * 1000).toISOString()
  await pairingCodeRows.insert(hash(code), at.toISOString(), expires)
  return { code, expires_at: expires }
}

/** The P-256 key in an SPKI DER, or null for anything else. */
function p256Key(publicKey: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? key : null
  } catch {
    return null
  }
}

const scopesOf = (row: Pick<DeviceRow, 'scopes'>): DeviceScope[] => {
  const parsed: unknown = JSON.parse(row.scopes)
  return Array.isArray(parsed)
    ? parsed.filter((scope): scope is DeviceScope => typeof scope === 'string' && DEVICE_SCOPE_SET.has(scope))
    : []
}

export const deviceInfo = (row: DeviceRow): DeviceInfo => ({
  id: row.id,
  name: row.name,
  platform: DEVICE_PLATFORMS.find((platform) => platform === row.platform) ?? 'other',
  scopes: scopesOf(row),
  created_at: row.created_at,
  last_seen_at: row.last_seen_at,
  show_names: row.show_names,
})

/** Trades a pairing code for a device with the widget scope; the code is used up either way. */
export async function pairDevice(input: DevicePairInput, at: Date = new Date()): Promise<DeviceRow> {
  if (!(await pairingCodeRows.consume(hash(input.code), at.toISOString()))) {
    throw new HttpError(401, 'That pairing code is wrong, used or expired; pair again from Settings')
  }
  if (p256Key(input.public_key) === null) {
    throw new HttpError(400, 'public_key must be the SPKI DER of an EC P-256 key, base64url')
  }
  if ((await deviceRows.byKey(input.public_key)) !== undefined) {
    throw new HttpError(409, 'A device with this key is already paired')
  }
  const row: DeviceRow = {
    id: randomUUID(),
    name: input.name,
    platform: input.platform,
    public_key: input.public_key,
    scopes: JSON.stringify(['widget'] satisfies DeviceScope[]),
    created_at: at.toISOString(),
    last_seen_at: null,
    show_names: true,
  }
  await deviceRows.insert(row)
  return row
}

const seenJtis = new Map<string, number>()

/** True the first time a device uses a jti; Redis keeps the memory across restarts and processes. */
async function firstUse(key: string, at: number): Promise<boolean> {
  for (const [seen, expires] of seenJtis) {
    if (expires > at) {
      break
    }
    seenJtis.delete(seen)
  }
  if (seenJtis.has(key)) {
    return false
  }
  seenJtis.set(key, at + JTI_TTL_MS)
  return cache.claim(`device-jti:${key}`, JTI_TTL_MS)
}

/** Why a proof was refused, for the server log; the device hears only that it was. */
export class ProofFailure extends Error {}

export interface DeviceIdentity {
  id: string
  name: string
  scopes: DeviceScope[]
  show_names: boolean
}

export interface ProofRequest {
  /** The Authorization header value. */
  authorization: string
  method: string
  /** Scheme, host and path of the request, without the query. */
  url: string
}

const PROOF = new RegExp(`^${DEVICE_AUTH_SCHEME} ([A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)$`)

export const isDeviceProof = (authorization: string) => authorization.startsWith(`${DEVICE_AUTH_SCHEME} `)

/** The device the proof's header names, after checking its algorithm and type. */
async function claimedDevice(jws: string): Promise<{ device: DeviceRow; key: KeyObject }> {
  let kid: unknown
  try {
    const header = decodeProtectedHeader(jws)
    kid = header.alg === 'ES256' && header.typ === DEVICE_PROOF_TYPE ? header.kid : undefined
  } catch {
    throw new ProofFailure('malformed header')
  }
  const device = typeof kid === 'string' ? await deviceRows.get(kid) : undefined
  const key = device === undefined ? null : p256Key(device.public_key)
  if (device === undefined || key === null) {
    throw new ProofFailure('wrong alg or typ, or an unknown or revoked device')
  }
  return { device, key }
}

async function signedClaims(jws: string, key: KeyObject, at: Date): Promise<Record<string, unknown>> {
  try {
    return (await jwtVerify(jws, key, { algorithms: ['ES256'], typ: DEVICE_PROOF_TYPE, currentDate: at })).payload
  } catch {
    throw new ProofFailure('bad signature')
  }
}

/** Checks a device proof: its key's signature, method, URL, age and a jti not seen before. */
export async function verifyDeviceProof(request: ProofRequest, at: Date = new Date()): Promise<DeviceIdentity> {
  const jws = PROOF.exec(request.authorization)?.[1]
  if (jws === undefined) {
    throw new ProofFailure('malformed proof')
  }
  const { device, key } = await claimedDevice(jws)
  const payload = await signedClaims(jws, key, at)
  if (payload.htm !== request.method || payload.htu !== request.url) {
    throw new ProofFailure('wrong htm or htu')
  }
  const iat = payload.iat
  if (typeof iat !== 'number' || Math.abs(at.getTime() / 1000 - iat) > DEVICE_PROOF_MAX_AGE_S) {
    throw new ProofFailure('stale iat')
  }
  const jti = payload.jti
  if (typeof jti !== 'string' || !JTI.test(jti) || !(await firstUse(`${device.id}:${jti}`, at.getTime()))) {
    throw new ProofFailure('replayed or missing jti')
  }
  if (device.last_seen_at === null || at.getTime() - Date.parse(device.last_seen_at) >= SEEN_EVERY_MS) {
    await deviceRows.seen(device.id, at.toISOString())
  }
  return { id: device.id, name: device.name, scopes: scopesOf(device), show_names: device.show_names }
}

/** The official app, and the self-built one from Settings, else from SETI_ANDROID_PACKAGE. */
export async function androidAppSettings(): Promise<AndroidAppSettings> {
  const official = {
    package_name: OFFICIAL_ANDROID_APP.package_name,
    cert_sha256: [...OFFICIAL_ANDROID_APP.cert_sha256],
  }
  const row = await androidAppRows.get()
  if (row === undefined) {
    return { official, override: ANDROID_OVERRIDE, replace_official: false }
  }
  const prints: unknown = JSON.parse(row.cert_sha256)
  const certs = Array.isArray(prints) ? prints.filter((print): print is string => typeof print === 'string') : []
  const override =
    row.package_name === null || certs.length === 0 ? null : { package_name: row.package_name, cert_sha256: certs }
  return { official, override, replace_official: override !== null && row.replace_official }
}

/** The trusted apps, one per package: the official unless replaced, and the self-built one. */
function trustedApps(settings: AndroidAppSettings): AndroidApp[] {
  const apps = settings.replace_official ? [] : [settings.official]
  if (settings.override !== null) {
    apps.push(settings.override)
  }
  const byPackage = new Map<string, Set<string>>()
  for (const app of apps) {
    const prints = byPackage.get(app.package_name) ?? new Set()
    app.cert_sha256.forEach((print) => prints.add(print))
    byPackage.set(app.package_name, prints)
  }
  return [...byPackage].map(([name, prints]) => ({ package_name: name, cert_sha256: [...prints] }))
}

/** Digital Asset Links for the apps: the TWA opens this host, and may use its passkeys. */
export async function assetLinks(): Promise<unknown[]> {
  return trustedApps(await androidAppSettings()).map((app) => ({
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: app.package_name, sha256_cert_fingerprints: app.cert_sha256 },
  }))
}
