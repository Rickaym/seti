import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { replaceFile, withStorageLock } from './mcp-oauth.js'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)

/** Claude Code's credentials file and its global config, which names the signed-in account. */
export interface LoginPaths {
  credentials: string
  config: string
}

/** A Claude Code login: its OAuth tokens and the profile Claude Code keeps for that account. */
export interface LoginSlot {
  oauth: Json
  account: Json | null
}

export interface LoginAbout {
  email: string | null
  organization: string | null
  plan: string | null
}

export interface HostLogin extends LoginSlot, LoginAbout {
  /** Claude Code's account and organization ids; null when its config names no account. */
  identity: string | null
}

function readJson(file: string): { data: Json; mode: number } | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false })
  if (stat?.isFile() !== true) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return isObject(parsed) ? { data: parsed, mode: stat.mode & 0o777 } : null
  } catch {
    return null
  }
}

const signedIn = (oauth: unknown): oauth is Json => isObject(oauth) && text(oauth.accessToken) !== null

/** The stable identity Claude Code itself compares logins by: account and organization ids. */
export function identityOf(account: Json | null): string | null {
  const uuid = text(account?.accountUuid)
  return uuid === null ? null : `${uuid}/${text(account?.organizationUuid) ?? ''}`
}

export const aboutOf = (slot: LoginSlot): LoginAbout => ({
  email: text(slot.account?.emailAddress),
  organization: text(slot.account?.organizationName),
  plan: text(slot.oauth.subscriptionType),
})

/** Tells token sets apart without keeping them: a refresh or another login changes it. */
export const fingerprint = (slot: LoginSlot): string =>
  createHash('sha256')
    .update(JSON.stringify([slot.oauth, identityOf(slot.account)]))
    .digest('hex')

/** The login Claude Code uses on this machine, or null when it is signed out. Never throws. */
export function readHostLogin(paths: LoginPaths): HostLogin | null {
  const oauth = readJson(paths.credentials)?.data.claudeAiOauth
  if (!signedIn(oauth)) {
    return null
  }
  const account = readJson(paths.config)?.data.oauthAccount
  const slot = { oauth, account: isObject(account) ? account : null }
  return { ...slot, ...aboutOf(slot), identity: identityOf(slot.account) }
}

/** Reads the login `claude auth login` wrote into a config directory of its own. */
export function readConfigDirLogin(dir: string): LoginSlot | null {
  const oauth = readJson(path.join(dir, '.credentials.json'))?.data.claudeAiOauth
  const account = readJson(path.join(dir, '.claude.json'))?.data.oauthAccount
  return signedIn(oauth) ? { oauth, account: isObject(account) ? account : null } : null
}

const LOCK_TRIES = 30
const LOCK_WAIT_MS = 100

const pause = async (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Runs `write` under Claude Code's lock for a file, waiting a few seconds for another writer. */
async function underLock<T>(lockOf: (write: () => T) => T | undefined, write: () => T, what: string): Promise<T> {
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    const result = lockOf(write)
    if (result !== undefined) {
      return result
    }
    await pause(LOCK_WAIT_MS)
  }
  throw new Error(`Claude Code kept ${what} locked; try again in a moment`)
}

/** Claude Code locks its global config with a directory named after the file plus `.lock`. */
function withConfigLock<T>(file: string, write: () => T): T | undefined {
  const lock = `${file}.lock`
  try {
    fs.mkdirSync(lock)
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'EEXIST') {
      return undefined
    }
    throw e
  }
  try {
    return write()
  } finally {
    fs.rmSync(lock, { recursive: true, force: true })
  }
}

/**
 * Puts a login in Claude Code's place: only `claudeAiOauth` in the credentials file, so MCP
 * sign-ins and every other key stay, and the account profile in its global config. Returns the
 * login it replaced, read under the same lock, so its newest tokens are not lost.
 */
export async function writeHostLogin(paths: LoginPaths, slot: LoginSlot): Promise<HostLogin | null> {
  const previous = await underLock(
    (write) => withStorageLock(paths.credentials, write),
    () => {
      const stat = fs.lstatSync(paths.credentials, { throwIfNoEntry: false })
      if (stat !== undefined && !stat.isFile()) {
        throw new Error(`${paths.credentials} is not a regular file; Seti leaves it alone`)
      }
      const before = readHostLogin(paths)
      const current = readJson(paths.credentials)
      fs.mkdirSync(path.dirname(paths.credentials), { recursive: true, mode: 0o700 })
      replaceFile(
        paths.credentials,
        JSON.stringify({ ...current?.data, claudeAiOauth: slot.oauth }),
        current?.mode ?? 0o600,
      )
      return { before }
    },
    'its credentials',
  )
  if (slot.account !== null) {
    await writeHostProfile(paths, slot.account)
  }
  return previous.before
}

/** Puts the account profile of a login in Claude Code's global config, keeping every other key. */
export async function writeHostProfile(paths: LoginPaths, account: Json): Promise<void> {
  const config = fs.existsSync(paths.config) ? fs.realpathSync(paths.config) : paths.config
  await underLock(
    (write) => withConfigLock(config, write),
    () => {
      const current = readJson(config)
      const next = { ...current?.data, oauthAccount: account }
      replaceFile(config, `${JSON.stringify(next, null, 2)}\n`, current?.mode ?? 0o600)
      return true
    },
    'its config',
  )
}

/** A digest of a token, so Seti can tell whose it is without holding it in the clear. */
export const tokenKey = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? createHash('sha256').update(value).digest('hex') : null
