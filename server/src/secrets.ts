import {
  DEFAULT_PROFILE_ID,
  githubSecretNames,
  SECRET_NAMES,
  type GitHubOwnerToken,
  type ProfileGitHub,
  type SecretName,
  type SecretSource,
  type SecretStatus,
  type StoredSecretName,
} from '@seti/shared'
import { audit } from './audit.js'
import { credential, missingCredential } from './credentials.js'
import { now, type Db } from './db.js'
import { parseKey, secretBox, type SecretBox } from './secret-box.js'
import { secretRows, type SecretRecord } from './store/secrets.js'

let box: SecretBox | null = null

/** The store's cipher, keyed by the secret-key credential; throws with setup steps without it. */
export function storeBox(): SecretBox {
  if (box === null) {
    const text = credential('secret-key')
    if (text === null) {
      throw new Error(missingCredential('secret-key'))
    }
    box = secretBox(parseKey(text))
  }
  return box
}

/** A stored secret that the current key cannot open. */
export class SecretUnreadableError extends Error {}

const context = (name: StoredSecretName) => `secret:${name}`

const statusOf = (name: SecretName, row: SecretRecord | undefined): SecretStatus => ({
  name,
  configured: row !== undefined,
  source: row?.source ?? null,
  updated_at: row?.updated_at ?? null,
})

/**
 * A secret's value for use inside the server, or null when it is not set. Never send the value to
 * a client; throws SecretUnreadableError when it is stored but will not open.
 */
export async function secret(name: StoredSecretName): Promise<string | null> {
  const row = await secretRows.get(name)
  if (row === undefined) {
    return null
  }
  try {
    return storeBox().open(row.sealed, context(name))
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e)
    throw new SecretUnreadableError(`The stored ${name} cannot be read: ${reason}. Set it again in Settings.`)
  }
}

/** When a secret last changed; sessions compare it to restart with a new value. */
export async function secretStamp(name: StoredSecretName): Promise<string | null> {
  return (await secretRows.get(name))?.updated_at ?? null
}

/** Values other modules keep in the store under their own names, such as ssh private keys. */
export const sealedSecrets = {
  put: async (name: StoredSecretName, value: string, db?: Db): Promise<void> => {
    await secretRows.put({ name, sealed: storeBox().seal(value, context(name)), source: 'settings', at: now() }, db)
  },
  remove: async (name: StoredSecretName, db?: Db): Promise<boolean> => secretRows.delete(name, db),
  /**
   * Replaces a value only while it still holds `expected`, as when a token endpoint rotates a
   * refresh token; false when another writer changed it first.
   */
  replaceIf: async (name: StoredSecretName, expected: string, next: string): Promise<boolean> =>
    secretRows.replaceIf(
      name,
      (sealed) => storeBox().open(sealed, context(name)) === expected,
      () => storeBox().seal(next, context(name)),
    ),
  /** Stores the value unless the name already has one; false when it did. */
  putIfAbsent: async (name: StoredSecretName, value: string): Promise<boolean> =>
    secretRows.putIfAbsent(name, storeBox().seal(value, context(name)), 'settings', now()),
}

/** A profile's GitHub tokens: its default one and one per owner, set and cleared by owner name. */
export function githubTokens(profileId: string) {
  const names = githubSecretNames(profileId)
  const put = async (name: StoredSecretName, value: string) =>
    secretRows.put({ name, sealed: storeBox().seal(value, context(name)), source: 'settings', at: now() })
  return {
    names,
    status: async (): Promise<ProfileGitHub> => {
      const row = await secretRows.get(names.token)
      const owners = (await secretRows.withPrefix(names.ownerPrefix)).map((owner) => ({
        owner: owner.name.slice(names.ownerPrefix.length),
        source: owner.source,
        updated_at: owner.updated_at,
      }))
      return {
        default: { configured: row !== undefined, source: row?.source ?? null, updated_at: row?.updated_at ?? null },
        owners,
      }
    },
    setDefault: async (value: string): Promise<void> => {
      await put(names.token, value)
    },
    clearDefault: async (): Promise<boolean> => secretRows.delete(names.token),
    setOwner: async (owner: string, value: string): Promise<GitHubOwnerToken> => {
      const row = await put(names.owner(owner), value)
      return { owner: owner.toLowerCase(), source: row.source, updated_at: row.updated_at }
    },
    clearOwner: async (owner: string): Promise<boolean> => secretRows.delete(names.owner(owner)),
    /** Removes every GitHub token of a deleted profile. */
    clearAll: async (): Promise<void> => {
      await secretRows.delete(names.token)
      await secretRows.deleteWithPrefix(names.ownerPrefix)
    },
    /** Changes when a token is set or cleared, so sessions started with an older one restart. */
    stamp: async (): Promise<string | null> => {
      const rows = [await secretRows.get(names.token), ...(await secretRows.withPrefix(names.ownerPrefix))]
      const stamps = rows.flatMap((row) => (row === undefined ? [] : [`${row.name}@${row.updated_at}`]))
      return stamps.length === 0 ? null : stamps.toSorted((a, b) => a.localeCompare(b, 'en')).join(',')
    },
  }
}

const GITHUB_REF = 'github_agent_token'

/** Where a poller's GitHub reference lives in the store: Default's tokens; null for other refs. */
export function githubRefName(ref: string): StoredSecretName | null {
  const github = githubSecretNames(DEFAULT_PROFILE_ID)
  if (ref === GITHUB_REF) {
    return github.token
  }
  if (ref.startsWith(`${GITHUB_REF}:`)) {
    return github.owner(ref.slice(GITHUB_REF.length + 1))
  }
  return null
}

/** Default's GitHub tokens as poller references. */
export async function githubPollerRefs(): Promise<string[]> {
  const status = await githubTokens(DEFAULT_PROFILE_ID).status()
  const github = status.default.configured ? [GITHUB_REF] : []
  return [...github, ...status.owners.map((token) => `${GITHUB_REF}:${token.owner}`)]
}

export const secrets = {
  list: async (): Promise<SecretStatus[]> => {
    const rows = new Map((await secretRows.list()).map((row) => [row.name, row]))
    return SECRET_NAMES.map((name) => statusOf(name, rows.get(name)))
  },
  set: async (name: SecretName, value: string, source: SecretSource): Promise<SecretStatus> =>
    statusOf(name, await secretRows.put({ name, sealed: storeBox().seal(value, context(name)), source, at: now() })),
  clear: async (name: SecretName): Promise<{ status: SecretStatus; removed: boolean }> => {
    const removed = await secretRows.delete(name)
    return { status: statusOf(name, undefined), removed }
  },
  /** Stores a value from an older env file once; false when the store already had one. */
  importOnce: async (name: StoredSecretName, value: string, from: string): Promise<boolean> => {
    const stored = await secretRows.putIfAbsent(name, storeBox().seal(value, context(name)), 'import', now())
    if (stored) {
      await audit.record({
        actor: 'system',
        kind: 'system.secret_imported',
        subject_type: 'system',
        subject_id: name,
        summary: `Imported the ${name} secret from ${from}`,
        detail: { name, from },
      })
    }
    return stored
  },
}
