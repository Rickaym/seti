import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ClaudeLogin, ClaudeLoginSecretName, ClaudeLogins } from '@seti/shared'
import { audit } from './audit.js'
import {
  aboutOf,
  fingerprint,
  identityOf,
  readHostLogin,
  tokenKey,
  writeHostLogin,
  writeHostProfile,
  type HostLogin,
  type LoginPaths,
  type LoginSlot,
} from './claude-login-file.js'
import { CLAUDE_HOME } from './config.js'
import { now } from './db.js'
import { fromDelegate } from './ea-guard.js'
import { HttpError } from './http.js'
import { sealedSecrets, secret } from './secrets.js'
import { loginRows, type LoginRow } from './store/claude-logins.js'

const CHECK_MS = 5000

export const loginPaths = (): LoginPaths => ({
  credentials: path.join(CLAUDE_HOME, '.credentials.json'),
  config: path.join(path.dirname(CLAUDE_HOME), '.claude.json'),
})

const slotName = (id: string): ClaudeLoginSecretName => `claude_login:${id}`

const toLogin = ({ identity: _identity, ...login }: LoginRow): ClaudeLogin => login

async function openSlot(id: string): Promise<LoginSlot | null> {
  const sealed = await secret(slotName(id))
  if (sealed === null) {
    return null
  }
  let parsed: { oauth?: unknown; account?: unknown }
  try {
    parsed = JSON.parse(sealed) as { oauth?: unknown; account?: unknown }
  } catch {
    throw new Error(`The saved login ${id} does not read as a Claude Code login`)
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  return isObject(parsed.oauth)
    ? { oauth: parsed.oauth, account: isObject(parsed.account) ? parsed.account : null }
    : null
}

/** The fingerprint of each slot as last written, so the keeper saves only what changed. */
const savedPrints = new Map<string, string>()

/**
 * Whose tokens are whose, by token digest. Claude Code may rewrite its config with a stale
 * profile, so tokens Seti saved or wrote name their login before the config does.
 */
const owners = new Map<string, string>()

function remember(identity: string, slot: LoginSlot): void {
  for (const token of [slot.oauth.accessToken, slot.oauth.refreshToken]) {
    const key = tokenKey(token)
    if (key !== null) {
      owners.set(key, identity)
    }
  }
}

function forget(identity: string): void {
  for (const [key, owner] of owners) {
    if (owner === identity) {
      owners.delete(key)
    }
  }
}

/** The identity of the login the host holds: by its tokens when Seti knows them, else its config. */
function ownerOf(host: HostLogin): string | null {
  for (const token of [host.oauth.accessToken, host.oauth.refreshToken]) {
    const owner = owners.get(tokenKey(token) ?? '')
    if (owner !== undefined) {
      return owner
    }
  }
  return host.identity
}

async function sealSlot(id: string, identity: string, slot: LoginSlot): Promise<void> {
  await sealedSecrets.put(slotName(id), JSON.stringify({ oauth: slot.oauth, account: slot.account }))
  savedPrints.set(id, fingerprint(slot))
  remember(identity, slot)
}

async function slotPrint(row: LoginRow): Promise<string | null> {
  const known = savedPrints.get(row.id)
  if (known !== undefined) {
    return known
  }
  const slot = await openSlot(row.id)
  if (slot === null) {
    return null
  }
  savedPrints.set(row.id, fingerprint(slot))
  remember(row.identity, slot)
  return fingerprint(slot)
}

let loaded: Promise<void> | null = null

/** Learns every saved login's tokens once, so a restart still tells whose the host's are. */
async function loadOwners(): Promise<void> {
  loaded ??= (async () => {
    for (const row of await loginRows.list()) {
      await slotPrint(row)
    }
  })().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

/** Saved logins stay the user's: the EA and agents with Seti control may only read their names. */
export function userOnly(what: string): void {
  if (fromDelegate()) {
    throw new HttpError(403, `Only the user can ${what}, in Seti`)
  }
}

/** Runs login changes one at a time, so a switch and the keeper never interleave. */
let queue: Promise<unknown> = Promise.resolve()
async function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work)
  queue = next.catch(() => undefined)
  return next
}

/** The identity of the login Claude Code uses now, which sessions record to restart on a switch. */
export function hostLoginKey(): string | null {
  const host = readHostLogin(loginPaths())
  return host === null ? null : (ownerOf(host) ?? 'unknown')
}

/** The saved logins, which one Claude Code uses, and who it is signed in as when none matches. */
export async function loginsView(): Promise<ClaudeLogins> {
  await loadOwners()
  const rows = await loginRows.list()
  const host = readHostLogin(loginPaths())
  const identity = host === null ? null : ownerOf(host)
  const active = identity === null ? undefined : rows.find((row) => row.identity === identity)
  return {
    accounts: rows.map(toLogin),
    active_id: active?.id ?? null,
    unsaved: host !== null && active === undefined ? { email: host.email, organization: host.organization } : null,
  }
}

async function freeName(name: string, except?: string): Promise<void> {
  const taken = await loginRows.byName(name)
  if (taken !== undefined && taken.id !== except) {
    throw new HttpError(409, `A login named ${taken.name} already exists`)
  }
}

/** A name for a login saved without one: its email, else a numbered one, never taken. */
async function autoName(host: HostLogin): Promise<string> {
  const base = (host.email ?? 'Saved login').slice(0, 36)
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base} ${String(n)}`
    if ((await loginRows.byName(name)) === undefined) {
      return name
    }
  }
}

async function insertLogin(name: string, slot: LoginSlot, identity: string): Promise<ClaudeLogin> {
  const at = now()
  const row: LoginRow = { id: randomUUID(), name, identity, ...aboutOf(slot), created_at: at, updated_at: at }
  await sealSlot(row.id, identity, slot)
  try {
    await loginRows.insert(row)
  } catch (e) {
    await sealedSecrets.remove(slotName(row.id))
    throw e
  }
  await audit.record({
    actor: 'user',
    kind: 'account.login_saved',
    subject_type: 'account',
    subject_id: row.id,
    summary: `Saved the Claude login ${name}`,
    detail: { name },
  })
  return toLogin(row)
}

/** Stores a login under a name, or refreshes the saved one with the same Claude Code identity. */
export async function keepLogin(name: string, slot: LoginSlot): Promise<{ login: ClaudeLogin; created: boolean }> {
  userOnly('add Claude logins')
  const identity = identityOf(slot.account)
  if (identity === null) {
    throw new HttpError(409, 'Claude Code has not recorded which account this login is; run claude once, then retry')
  }
  return serial(async () => {
    const existing = await loginRows.byIdentity(identity)
    if (existing !== undefined) {
      await sealSlot(existing.id, identity, slot)
      await loginRows.describe(existing.id, aboutOf(slot), now())
      await audit.record({
        actor: 'user',
        kind: 'account.login_updated',
        subject_type: 'account',
        subject_id: existing.id,
        summary: `Signed in to the saved Claude login ${existing.name} again`,
        detail: { name: existing.name },
      })
      return { login: toLogin((await loginRows.get(existing.id)) ?? existing), created: false }
    }
    await freeName(name)
    return { login: await insertLogin(name, slot, identity), created: true }
  })
}

export async function saveCurrentLogin(name: string): Promise<ClaudeLogin> {
  userOnly('add Claude logins')
  await loadOwners()
  const host = readHostLogin(loginPaths())
  if (host === null) {
    throw new HttpError(409, 'Claude Code is not logged in on this machine')
  }
  const owner = ownerOf(host)
  const saved = owner === null ? undefined : await loginRows.byIdentity(owner)
  if (saved !== undefined) {
    throw new HttpError(409, `This login is already saved as ${saved.name}`)
  }
  return (await keepLogin(name, host)).login
}

async function rowOf(id: string): Promise<LoginRow> {
  const row = await loginRows.get(id)
  if (row === undefined) {
    throw new HttpError(404, 'No such saved login')
  }
  return row
}

export async function renameLogin(id: string, name: string): Promise<ClaudeLogin> {
  userOnly('rename Claude logins')
  return serial(async () => {
    const row = await rowOf(id)
    if (row.name === name) {
      return toLogin(row)
    }
    await freeName(name, id)
    await loginRows.rename(id, name, now())
    await audit.record({
      actor: 'user',
      kind: 'account.login_renamed',
      subject_type: 'account',
      subject_id: id,
      summary: `Renamed the Claude login ${row.name} to ${name}`,
      detail: { from: row.name, to: name },
    })
    return toLogin(await rowOf(id))
  })
}

export async function removeLogin(id: string): Promise<void> {
  userOnly('remove Claude logins')
  await serial(async () => {
    const row = await rowOf(id)
    await loadOwners()
    const host = readHostLogin(loginPaths())
    if (host !== null && ownerOf(host) === row.identity) {
      throw new HttpError(409, `${row.name} is the login in use; switch to another one first`)
    }
    await loginRows.delete(id)
    await sealedSecrets.remove(slotName(id))
    savedPrints.delete(id)
    forget(row.identity)
    await audit.record({
      actor: 'user',
      kind: 'account.login_removed',
      subject_type: 'account',
      subject_id: id,
      summary: `Removed the saved Claude login ${row.name}`,
      detail: { name: row.name },
    })
  })
}

/**
 * Stores the host login's tokens in its saved slot when they changed; false when none matches.
 * When Claude Code's config names another account than the tokens' login, it gets the right one.
 */
async function saveBack(host: HostLogin): Promise<boolean> {
  const identity = ownerOf(host)
  const row = identity === null ? undefined : await loginRows.byIdentity(identity)
  if (identity === null || row === undefined) {
    return false
  }
  let slot: LoginSlot = host
  if (host.identity !== identity) {
    const account = (await openSlot(row.id))?.account ?? null
    slot = { oauth: host.oauth, account }
    if (account !== null) {
      await writeHostProfile(loginPaths(), account)
    }
  }
  if ((await slotPrint(row)) !== fingerprint(slot)) {
    await sealSlot(row.id, identity, slot)
    const about = aboutOf(slot)
    if (about.email !== row.email || about.organization !== row.organization || about.plan !== row.plan) {
      await loginRows.describe(row.id, about, now())
    }
  }
  return true
}

export interface SwitchResult {
  login: ClaudeLogin
  /** The login that was in use and matched no saved one, saved under its email so it is kept. */
  kept: ClaudeLogin | null
}

/**
 * Makes a saved login the one Claude Code uses. The login in use first goes back to its slot with
 * its newest tokens, or is saved under its email when it matches none, so no login is lost.
 */
export async function switchLogin(id: string): Promise<SwitchResult> {
  userOnly('switch Claude logins')
  return serial(async () => {
    const target = await rowOf(id)
    const slot = await openSlot(id)
    if (slot === null) {
      throw new HttpError(409, `The tokens of ${target.name} are missing; log in to it again`)
    }
    await loadOwners()
    const paths = loginPaths()
    const current = readHostLogin(paths)
    const owner = current === null ? null : ownerOf(current)
    let kept: ClaudeLogin | null = null
    if (owner === target.identity) {
      return { login: toLogin(target), kept }
    }
    if (current !== null && owner === null) {
      throw new HttpError(
        409,
        'Claude Code has not recorded which account it is logged in to; run claude once, then retry',
      )
    }
    if (current !== null && owner !== null && !(await saveBack(current))) {
      kept = await insertLogin(await autoName(current), current, owner)
    }
    remember(target.identity, slot)
    const replaced = await writeHostLogin(paths, slot)
    if (replaced !== null && current !== null && fingerprint(replaced) !== fingerprint(current)) {
      await saveBack(replaced)
    }
    await audit.record({
      actor: 'user',
      kind: 'account.switched',
      subject_type: 'account',
      subject_id: id,
      summary: `Switched Claude Code to the login ${target.name}`,
      detail: { name: target.name },
    })
    return { login: toLogin(target), kept }
  })
}

/**
 * The access token of a saved login that is no longer in use, for a session that started on it;
 * null when no saved login has that identity.
 */
export async function savedAccessToken(identity: string): Promise<string | null> {
  const row = await loginRows.byIdentity(identity)
  const token = row === undefined ? undefined : (await openSlot(row.id))?.oauth.accessToken
  return typeof token === 'string' && token !== '' ? token : null
}

export type KeeperOutcome = 'none' | 'saved' | 'unsaved' | 'signed_out'

/**
 * Follows Claude Code's credentials: a login that matches a saved one, refreshed by Claude Code
 * or signed in again in a terminal, goes back to its slot once it held still for a check, since
 * /login writes the tokens a moment before the account profile.
 */
export function createLoginKeeper() {
  let last: string | null = null
  const check = async (): Promise<KeeperOutcome> => {
    await loadOwners()
    const host = readHostLogin(loginPaths())
    if (host === null) {
      last = null
      return 'signed_out'
    }
    const print = fingerprint(host)
    const steady = print === last
    last = print
    if (!steady) {
      return 'none'
    }
    return (await serial(async () => saveBack(host))) ? 'saved' : 'unsaved'
  }
  return { check }
}

export function startLoginKeeper(): void {
  const keeper = createLoginKeeper()
  const run = () => {
    keeper.check().catch((e: unknown) => {
      process.stderr.write(`login-keeper: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
  run()
  setInterval(run, CHECK_MS).unref()
}
