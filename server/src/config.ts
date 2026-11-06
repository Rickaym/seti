import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { androidAppSchema, AWAY_MS, MOD_LIMITS, POLLER_LIMITS, SETI_HOSTNAMES, type AndroidApp } from '@seti/shared'
import { findClaudeBin } from './claude-bin.js'
import { socketUrl } from './pg.js'

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}

/** Tests that fell back to ~/.seti or ~/.claude would rewrite the live instance and user config. */
const unset = (name: string) => (process.env[name] ?? '') === ''
if (process.env.VITEST !== undefined && (unset('SETI_HOME') || unset('SETI_CLAUDE_HOME'))) {
  throw new Error('Tests must set SETI_HOME and SETI_CLAUDE_HOME to scratch directories')
}
if (process.env.VITEST !== undefined && unset('SETI_DATABASE_URL')) {
  throw new Error('Tests must set SETI_DATABASE_URL to a scratch database')
}

const DEFAULT_HOME = path.join(os.homedir(), '.seti')

export const SETI_HOME = env('SETI_HOME', DEFAULT_HOME)
export const CLAUDE_HOME = env('SETI_CLAUDE_HOME', path.join(os.homedir(), '.claude'))
export const WORKTREE_ROOT = path.join(SETI_HOME, 'worktrees')
/** Where an agent started without a repo or directory gets a fresh working directory. */
export const SCRATCH_ROOT = env('SETI_SCRATCH_ROOT', path.join(os.homedir(), 'work'))
export const BACKUP_DIR = path.join(SETI_HOME, 'backups')
/** Archived agents' folders, packed into one bundle per agent. */
export const ARCHIVE_ROOT = path.join(SETI_HOME, 'archive')
/** Bare git repositories a mod install fetches into, each removed once read. */
export const MOD_FETCH_ROOT = path.join(SETI_HOME, 'mod-fetch')

/** Development and test runs make their own credentials; production only reads them. */
const DEV_MODE =
  process.env.VITEST !== undefined || process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'

/** Where the server reads its credentials, and whether it may create missing ones there. */
export interface CredentialSource {
  dir: string
  dev: boolean
}

/** systemd's credentials, else a development run's own, else SETI_CREDENTIALS_DIR. */
export function credentialSource(
  source: Readonly<Record<string, string | undefined>>,
  home: string,
  dev: boolean,
): CredentialSource {
  const systemd = source.CREDENTIALS_DIRECTORY ?? ''
  if (systemd !== '' && source.VITEST === undefined) {
    return { dir: systemd, dev: false }
  }
  const configured = (name: string, fallback: string) => {
    const value = source[name] ?? ''
    return value === '' ? fallback : value
  }
  if (dev) {
    return { dir: configured('SETI_DEV_CREDENTIALS_DIR', path.join(home, 'dev-credentials')), dev: true }
  }
  return { dir: configured('SETI_CREDENTIALS_DIR', path.join(home, 'credentials')), dev: false }
}

/** Lets pollers of a development or test server reach this machine, as e2e fixtures need. */
export const POLLER_LOOPBACK = DEV_MODE && process.env.SETI_POLLER_LOOPBACK === '1'

/** Development and test runs may push to a loopback endpoint, which stands in for a push service. */
export const PUSH_LOOPBACK = DEV_MODE && process.env.SETI_PUSH_LOOPBACK === '1'

/** Development and test runs may load the mods only Seti's own tests use, such as the sample. */
export const TEST_MODS_ON = DEV_MODE && process.env.SETI_TEST_MODS === '1'

/**
 * Test runs may point mods' requests for names under .test at a fake HTTPS upstream on this
 * machine's port; its certificate is trusted through NODE_EXTRA_CA_CERTS.
 */
export const MOD_TEST_UPSTREAM = TEST_MODS_ON ? testUpstreamPort(process.env.SETI_MOD_TEST_UPSTREAM) : null

function testUpstreamPort(value: string | undefined): number | null {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null
}

/** Starts Seti with every third-party mod off, whatever Settings, Mods says. */
export const SAFE_MODE_FORCED = process.env.SETI_SAFE_MODE === '1'

/** A module whose `plannerModel` replaces the planner's model call, as the e2e suite's fake does. */
export const PLANNER_MODULE = DEV_MODE ? env('SETI_PLANNER_MODULE', '') : ''

/** A shell host terminals start instead of the account's, so e2e runs never depend on the host. */
export const TERMINAL_SHELL = DEV_MODE ? env('SETI_TERMINAL_SHELL', '') : ''

/** A module whose `query` replaces the Agent SDK's for sessions, as the e2e suite's fake does. */
export const SDK_MODULE = DEV_MODE ? env('SETI_SDK_MODULE', '') : ''

export const CREDENTIALS = credentialSource(process.env, SETI_HOME, DEV_MODE)
/** Agents and shells inherit the server's environment; they must not learn where its keys are. */
delete process.env.CREDENTIALS_DIRECTORY
delete process.env.SETI_CREDENTIALS_DIR

/** `seti` for the default home; every other SETI_HOME, such as a scratch instance, gets its own. */
function databaseName(home: string): string {
  const resolved = path.resolve(home)
  if (resolved === DEFAULT_HOME) {
    return 'seti'
  }
  return `seti_${createHash('sha256').update(resolved).digest('hex').slice(0, 12)}`
}

export const DATABASE_URL = env('SETI_DATABASE_URL', socketUrl(databaseName(SETI_HOME)))

/** A Redis unix socket path or redis:// URL; `off` runs without Redis. */
export const REDIS_URL = env('SETI_REDIS_URL', '/run/seti-redis/redis.sock')
export const CLAUDE_BIN = findClaudeBin(process.env.SETI_CLAUDE_BIN)
export const HOST = env('SETI_HOST', '127.0.0.1')
export const PORT = Number(env('SETI_PORT', '3006'))
export const UI_DIST = path.resolve(import.meta.dirname, '../../ui/dist')
/** The checkout Seti runs from, whose git history is its changelog. */
export const SETI_SOURCE_DIR = env('SETI_SOURCE_DIR', path.resolve(import.meta.dirname, '../..'))

/**
 * Claude Code's auto mode: the permission rules decide first, edits in the agent's directories go
 * ahead, and a classifier allows or turns down the rest, asking through canUseTool when unsure.
 */
export const PERMISSION_MODE = 'auto' as const

function readIdleMinutes(value: string): number {
  const minutes = Number(value)
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(`SETI_SESSION_IDLE_MINUTES must be a positive number of minutes, not ${value}`)
  }
  return minutes
}

/** A whole number of at least one, or null when the variable is unset. */
export function readCount(name: string, value: string | undefined, unit: string): number | null {
  const text = value?.trim() ?? ''
  if (text === '') {
    return null
  }
  const count = Number(text)
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${name} must be a whole number of ${unit}, not ${text}`)
  }
  return count
}

/** Holds every capability probe back this long in development and tests, to act out a slow start. */
export const PROBE_DELAY_MS = DEV_MODE
  ? (readCount('SETI_PROBE_DELAY_MS', process.env.SETI_PROBE_DELAY_MS, 'milliseconds') ?? 0)
  : 0

/** How often the PR poller asks GitHub; tests shorten it to see updates arrive. */
export const PR_POLL_MS = DEV_MODE
  ? (readCount('SETI_PR_POLL_MS', process.env.SETI_PR_POLL_MS, 'milliseconds') ?? 60_000)
  : 60_000

/** No focused page and no live call for this long counts as away; tests shorten it to see a brief. */
export const AWAY_AFTER_MS = DEV_MODE
  ? (readCount('SETI_AWAY_MS', process.env.SETI_AWAY_MS, 'milliseconds') ?? AWAY_MS)
  : AWAY_MS

/** Audit events older than this are deleted; a year by default, as security logs usually need. */
export const AUDIT_RETENTION_DAYS =
  readCount('SETI_AUDIT_RETENTION_DAYS', process.env.SETI_AUDIT_RETENTION_DAYS, 'days') ?? 365

/** Tasks idle this long are deleted with their transcripts; unset keeps every task. */
export const TASK_RETENTION_DAYS = readCount('SETI_TASK_RETENTION_DAYS', process.env.SETI_TASK_RETENTION_DAYS, 'days')

/** Worker threads that run poller scripts; at most the number of polls that run at once. */
export const POLLER_WORKERS = Math.min(
  readCount('SETI_POLLER_WORKERS', process.env.SETI_POLLER_WORKERS, 'workers') ?? 2,
  POLLER_LIMITS.concurrentRuns,
)

/** Locked-down processes that run third-party mod logic, one event each at a time; 1 to 3. */
export function readModWorkers(value: string | undefined): number {
  const count = readCount('SETI_MOD_WORKERS', value, 'processes') ?? MOD_LIMITS.workersMin
  if (count > MOD_LIMITS.workersMax) {
    throw new Error(`SETI_MOD_WORKERS must be ${String(MOD_LIMITS.workersMin)} to ${String(MOD_LIMITS.workersMax)}`)
  }
  return count
}

export const MOD_WORKERS = readModWorkers(process.env.SETI_MOD_WORKERS)

/** Encrypted database backups; off unless SETI_BACKUP_PUBLIC_KEY names the key to encrypt to. */
export interface BackupConfig {
  publicKey: string
  keep: number
  intervalHours: number
}

export function readBackupConfig(source: Readonly<Record<string, string | undefined>>): BackupConfig | null {
  const publicKey = source.SETI_BACKUP_PUBLIC_KEY?.trim() ?? ''
  if (publicKey === '') {
    return null
  }
  return {
    publicKey,
    keep: readCount('SETI_BACKUP_KEEP', source.SETI_BACKUP_KEEP, 'backups') ?? 14,
    intervalHours: readCount('SETI_BACKUP_INTERVAL_HOURS', source.SETI_BACKUP_INTERVAL_HOURS, 'hours') ?? 24,
  }
}

export const BACKUP = readBackupConfig(process.env)

/** A passkey session ends after this long without a request, and in any case after AUTH_MAX_DAYS. */
export const AUTH_IDLE_DAYS = readCount('SETI_AUTH_IDLE_DAYS', process.env.SETI_AUTH_IDLE_DAYS, 'days') ?? 7
export const AUTH_MAX_DAYS = readCount('SETI_AUTH_MAX_DAYS', process.env.SETI_AUTH_MAX_DAYS, 'days') ?? 30

/** How long a task's Claude Code process stays open with no turn and no background work. */
export const SESSION_IDLE_MS = readIdleMinutes(env('SETI_SESSION_IDLE_MINUTES', '15')) * 60_000

/** How long a turn waits, after a notification turn's result, for Claude Code to read its message. */
export const OPENER_WAIT_MS = 5000

/** Cloudflare Access in front of the public hostname, whose JWT Seti verifies itself. */
export interface CloudflareAccess {
  /** Access team domain such as `myteam.cloudflareaccess.com`. */
  team: string
  aud: string
  /** Lowercase Access identities let in; null lets in whoever the Access policy admits. */
  allowed: ReadonlySet<string> | null
}

/** Public hostname served through a tunnel or proxy, and the Access app guarding it, if any. */
export interface PublicAccess {
  /** Lowercase hostname the tunnel forwards as the Host header. */
  hostname: string
  /** The only Origin accepted for writes through the tunnel. */
  origin: string
  /** Null when Seti's own passkey sign-in is the only gate. */
  cloudflare: CloudflareAccess | null
}

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/
const AUD_TAG = /^[A-Za-z0-9]{16,128}$/

function publicHostname(value: string): string {
  if (!URL.canParse(value)) {
    throw new Error(`SETI_PUBLIC_URL is not a URL: ${value}`)
  }
  const url = new URL(value)
  const bare = url.pathname === '/' && url.search === '' && url.hash === ''
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || !bare) {
    throw new Error('SETI_PUBLIC_URL must be a bare https origin such as https://seti.example.com')
  }
  const hostname = url.hostname.toLowerCase()
  if (SETI_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || !hostname.includes('.')) {
    throw new Error('SETI_PUBLIC_URL must be a public hostname, not a loopback name')
  }
  return hostname
}

const EMAIL = /^[^\s@]+@[^\s@]+$/
const TOKEN_NAME = /^[\w.-]+$/

/** Emails, or service token common names, separated by commas or whitespace. */
function readAllowed(value: string | undefined): ReadonlySet<string> | null {
  const entries = (value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
  if (entries.length === 0) {
    return null
  }
  const bad = entries.find((entry) => !EMAIL.test(entry) && !TOKEN_NAME.test(entry))
  if (bad !== undefined) {
    throw new Error(`SETI_ACCESS_EMAILS has an entry that is not an email or token name: ${bad}`)
  }
  return new Set(entries)
}

const teamDomain = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, '')
    .replace(/\/$/, '')

function readCloudflare(source: Readonly<Record<string, string | undefined>>): CloudflareAccess | null {
  const team = teamDomain(source.SETI_ACCESS_TEAM ?? '')
  const aud = source.SETI_ACCESS_AUD?.trim() ?? ''
  if (team === '' && aud === '') {
    return null
  }
  if (team === '' || aud === '') {
    throw new Error('Set both SETI_ACCESS_TEAM and SETI_ACCESS_AUD for Cloudflare Access, or neither')
  }
  if (!TEAM_DOMAIN.test(team)) {
    throw new Error('SETI_ACCESS_TEAM must be the Access team domain, such as myteam.cloudflareaccess.com')
  }
  if (!AUD_TAG.test(aud)) {
    throw new Error('SETI_ACCESS_AUD must be the Access application audience tag')
  }
  return { team, aud, allowed: readAllowed(source.SETI_ACCESS_EMAILS) }
}

/**
 * Null without SETI_PUBLIC_URL. Without Access settings the public host admits only Seti's own
 * sign-in; a half-set or malformed Access configuration throws.
 */
export function readPublicAccess(source: Readonly<Record<string, string | undefined>>): PublicAccess | null {
  const url = source.SETI_PUBLIC_URL?.trim() ?? ''
  if (url === '') {
    return null
  }
  const hostname = publicHostname(url)
  return { hostname, origin: `https://${hostname}`, cloudflare: readCloudflare(source) }
}

export const PUBLIC_ACCESS = readPublicAccess(process.env)

/** A self-built Android app trusted next to the official one until Settings sets one. */
export function readAndroidOverride(source: Readonly<Record<string, string | undefined>>): AndroidApp | null {
  const name = source.SETI_ANDROID_PACKAGE?.trim() ?? ''
  const prints = (source.SETI_ANDROID_CERT_SHA256 ?? '').split(/[\s,]+/).filter((print) => print !== '')
  if (name === '' && prints.length === 0) {
    return null
  }
  const parsed = androidAppSchema.safeParse({ package_name: name, cert_sha256: prints })
  if (!parsed.success) {
    throw new Error(`SETI_ANDROID_PACKAGE or SETI_ANDROID_CERT_SHA256: ${parsed.error.issues[0]?.message ?? ''}`)
  }
  return parsed.data
}

export const ANDROID_OVERRIDE = readAndroidOverride(process.env)

/** The origin of the EA voice bot that /api/ea forwards to. */
export function readEaUrl(value: string): string {
  const url = URL.canParse(value) ? new URL(value) : null
  if (url === null || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error(`SETI_EA_URL must be an http origin such as http://127.0.0.1:3007, not ${value}`)
  }
  return url.origin
}

export const EA_URL = readEaUrl(env('SETI_EA_URL', 'http://127.0.0.1:3007'))

/** The EA's older env file; Seti reads only OPENAI_API_KEY from it, for embeddings. */
export const EA_ENV_PATH = env('SETI_EA_ENV', path.join(SETI_HOME, 'ea.env'))

fs.mkdirSync(WORKTREE_ROOT, { recursive: true, mode: 0o700 })
