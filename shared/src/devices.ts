import { z } from 'zod'

/** Device pairing and proofs for the native app; docs/security.md describes the protocol. */
export const DEVICE_PAIR_PATH = '/api/devices/pair'
export const WIDGET_SUMMARY_PATH = '/api/widget/summary'
export const PAIR_PAGE_PATH = '/pair'
export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json'
export const DEVICE_AUTH_SCHEME = 'SetiDevice'
export const DEVICE_PROOF_TYPE = 'seti-device+jwt'
export const DEVICE_PROOF_MAX_AGE_S = 60
export const PAIRING_CODE_TTL_S = 5 * 60

/** What a device may reach; `widget` is the read-only home screen summary. */
export const DEVICE_SCOPES = ['widget'] as const
export type DeviceScope = (typeof DEVICE_SCOPES)[number]

export const DEVICE_PLATFORMS = ['android', 'ios', 'other'] as const
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number]

export const DEVICE_NAME_MAX = 60

const deviceName = z
  .string()
  .trim()
  .min(1, 'Type a name')
  .max(DEVICE_NAME_MAX, `Keep it under ${String(DEVICE_NAME_MAX)} characters`)
  .refine((name) => !/\p{Cc}/u.test(name), 'Names cannot contain control characters')

const B64URL = /^[A-Za-z0-9_-]+$/

export const devicePairInput = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, 'Unknown pairing code'),
  name: deviceName,
  platform: z.enum(DEVICE_PLATFORMS),
  /** SPKI DER of an EC P-256 public key, base64url. */
  public_key: z.string().min(80).max(512).regex(B64URL, 'Expected base64url'),
})
export type DevicePairInput = z.input<typeof devicePairInput>

export interface DevicePaired {
  device_id: string
  scopes: DeviceScope[]
}

export const deviceNameInput = z.object({ name: deviceName })
export type DeviceNameInput = z.input<typeof deviceNameInput>

export interface DeviceInfo {
  id: string
  name: string
  platform: DevicePlatform
  scopes: DeviceScope[]
  created_at: string
  last_seen_at: string | null
  /** Its widgets show agent titles; off, they show generic labels on the home screen. */
  show_names: boolean
}

/** A code Settings shows once, as text and as the QR code of `url`. */
export interface PairingCode {
  code: string
  url: string
  expires_at: string
}

/** An Android app that Digital Asset Links tie to this host, for the TWA and passkey sharing. */
export interface AndroidApp {
  package_name: string
  /** SHA-256 fingerprints of the app's signing certificates, as AB:CD:... */
  cert_sha256: string[]
}

/** The published Seti app. Every Seti trusts it unless a self-built app explicitly replaces it. */
export const OFFICIAL_ANDROID_APP: Readonly<AndroidApp> = Object.freeze({
  package_name: 'dev.seti.android',
  cert_sha256: ['EB:99:1B:D2:95:CC:C5:BA:C1:4E:ED:54:F6:D5:28:42:C7:41:DF:03:35:54:E4:CA:DA:AE:8C:09:6A:E9:76:F6'],
})

/** The official app, and an app the user builds and signs themselves. */
export interface AndroidAppSettings {
  official: AndroidApp
  /** A self-built app; null when none is set. */
  override: AndroidApp | null
  /** True when the override replaces the official app instead of joining it. */
  replace_official: boolean
}

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/

export const androidAppSchema = z.object({
  package_name: z
    .string()
    .trim()
    .max(255)
    .regex(/^([a-zA-Z]\w*\.)+[a-zA-Z]\w*$/, 'Use a package name such as com.example.seti'),
  cert_sha256: z
    .array(
      z
        .string()
        .trim()
        .transform((value) => value.toUpperCase())
        .pipe(z.string().regex(FINGERPRINT, 'Fingerprints are 32 hex bytes separated by colons')),
    )
    .min(1, 'Add the SHA-256 fingerprint of the signing certificate')
    .max(10),
})

export const androidAppInput = z
  .object({ override: androidAppSchema.nullable(), replace_official: z.boolean() })
  .refine((input) => input.override !== null || !input.replace_official, {
    message: 'Set a self-built app before it replaces the official one',
    path: ['replace_official'],
  })
export type AndroidAppInput = z.input<typeof androidAppInput>
