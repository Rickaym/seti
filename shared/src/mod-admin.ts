import { z } from 'zod'
import type { ModIcon } from './mod-listing.js'
import { modId, type ModCapability, type ModManifest } from './mods.js'

const KB = 1024

/** What a third-party package may hold, and how Seti keeps and updates it. */
export const MOD_PACKAGE_LIMITS = {
  manifestBytes: 64 * KB,
  logicBytes: 512 * KB,
  pageBytes: 512 * KB,
  pages: 8,
  docBytes: 64 * KB,
  iconBytes: 32 * KB,
  /** The widest and tallest a PNG icon may be, in pixels. */
  iconPixels: 512,
  totalBytes: 2 * KB * KB,
  /** Versions kept besides the current and pending ones, for rollback. */
  previousKept: 2,
  updateDelayHours: 24,
  updateDelayMaxHours: 168,
  /** How recent a passkey step-up must be for consent when Require passkey is on. */
  stepUpMs: 5 * 60_000,
  gitTimeoutMs: 60_000,
  gitFetchBytes: 20 * KB * KB,
} as const

export const MOD_SOURCE_KINDS = ['folder', 'git', 'dev'] as const
export type ModSourceKind = (typeof MOD_SOURCE_KINDS)[number]

/** consent: it widens a capability and waits for the user; delay: it applies on its own later. */
export const MOD_UPDATE_REASONS = ['consent', 'delay'] as const
export type ModUpdateReason = (typeof MOD_UPDATE_REASONS)[number]

/** The refusal a consent route gives while Require passkey is on and no recent step-up was made. */
export const STEP_UP_REFUSAL = 'Confirm with your passkey'

/** A package's content hash: 64 lowercase hex digits of SHA-256. */
export const modHash = z.string().regex(/^[a-f0-9]{64}$/, 'A package hash is 64 hex digits')

/** The hash as the UI shows it. */
export const shortModHash = (hash: string): string => `sha256:${hash.slice(0, 12)}`

const gitRef = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'A ref is a branch, tag or commit, such as main or v1.2.0')
  .refine((ref) => !ref.includes('..') && !ref.endsWith('.lock') && !ref.endsWith('/'), 'That is not a git ref')

const gitUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((url) => {
    if (!URL.canParse(url)) {
      return false
    }
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === ''
  }, 'Use an https:// URL with no user name or password')

/** Where to read a package: a folder on the Seti host, or a git repository at a ref. */
export const modSourceInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('folder'), path: z.string().trim().min(2).max(4096).startsWith('/') }),
  z.strictObject({ kind: z.literal('git'), url: gitUrl, ref: gitRef }),
])
export type ModSourceInput = z.input<typeof modSourceInput>

export const modPreviewInput = z.strictObject({ source: modSourceInput })
export type ModPreviewInput = z.input<typeof modPreviewInput>

const connectionBindings = z.record(z.string().max(64), z.string().min(1).max(64))

export const modInstallInput = z.strictObject({
  mod_id: modId,
  hash: modHash,
  connections: connectionBindings.default({}),
  /** Deletes the data and settings an earlier install of the same id left behind. */
  delete_earlier_data: z.boolean().default(false),
})
export type ModInstallInput = z.input<typeof modInstallInput>

export const modUpdateApplyInput = z.strictObject({ hash: modHash, connections: connectionBindings.optional() })
export type ModUpdateApplyInput = z.input<typeof modUpdateApplyInput>

export const modHashInput = z.strictObject({ hash: modHash })
export type ModHashInput = z.input<typeof modHashInput>

export const modInstallChangeInput = z
  .strictObject({
    update_delay_hours: z.number().int().min(0).max(MOD_PACKAGE_LIMITS.updateDelayMaxHours).optional(),
    track: gitRef.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), 'Say what to change')
export type ModInstallChangeInput = z.input<typeof modInstallChangeInput>

export const modUninstallInput = z.strictObject({ delete_data: z.boolean() })
export type ModUninstallInput = z.input<typeof modUninstallInput>

export const modDevModeInput = z.strictObject({ on: z.boolean() })
export type ModDevModeInput = z.input<typeof modDevModeInput>

export const modDevInput = z.strictObject({ path: z.string().trim().min(2).max(4096).startsWith('/') })
export type ModDevInput = z.input<typeof modDevInput>

export const modBisectAnswerInput = z.strictObject({ broken: z.boolean() })
export type ModBisectAnswerInput = z.input<typeof modBisectAnswerInput>

/** One capability on the consent screen, in Seti's words, never the mod's. */
export interface ModConsentLine {
  capability: ModCapability
  text: string
  /** Detail for the tooltip. */
  detail: string | null
  /** For a connection: the user's connections with that variable, to bind one. */
  connections: { id: string; name: string }[] | null
}

/** A package Seti read and checked, staged but not installed, for the consent view. */
export interface ModInstallPreview {
  mod_id: string
  hash: string
  size: number
  manifest: ModManifest
  icon: ModIcon | null
  /** The package's README, shown on the consent screen as the mod's own words. */
  readme: string | null
  source: { kind: ModSourceKind; display: string; commit: string | null }
  capabilities: ModConsentLine[]
  /** What it adds: commands, views, schedules and the rest, in plain words. */
  adds: string[]
  warnings: string[]
  /** Data an earlier install of the same id left behind, and where that one came from. */
  earlier_data: { source: string; bytes: number; settings: number } | null
  /** Why it cannot be installed, such as a manifest error; null when it can. */
  problem: string | null
}

/** An update waiting on the user's consent or on its delay. */
export interface ModPendingUpdate {
  hash: string
  version: string
  reason: ModUpdateReason
  since: string
  /** When a delayed update applies on its own; null when it waits for consent. */
  applies_at: string | null
  /** Only what changed, in Seti's words, such as "Now also: Sends and receives data with x". */
  changes: string[]
  /** Connections the new version needs that are not bound yet, each to pick before approving. */
  bindings: ModConsentLine[]
  /** A lower version than the one that runs. */
  older: boolean
}

/** How a third-party mod was installed, for its card in Settings, Mods. */
export interface ModInstallInfo {
  source_kind: ModSourceKind
  source: string
  track: string | null
  hash: string
  update_delay_hours: number
  pending: ModPendingUpdate | null
  /** Kept versions besides the current one, newest first, to roll back to. */
  versions: { hash: string; version: string; fetched_at: string }[]
  /** Its newest error line from its log, or null. */
  last_error: string | null
  /** What uninstalling would leave behind unless the user deletes it. */
  data_bytes: number
  settings_count: number
}

/** Where a mod bisect stands; the bar on every page reads it. */
export interface ModBisectState {
  step: number
  /** Mods still under suspicion. */
  suspects: string[]
  /** The one left, once the bisect narrowed it down. */
  culprit: string | null
  started_at: string
}
