import type { ConnectionSecretName, ConnectionSlot, StoredSecretName } from '@seti/shared'
import type { Db } from './db.js'
import { githubPollerRefs, githubRefName, sealedSecrets, secret } from './secrets.js'
import { connectionRows, type ConnectionRow } from './store/connections.js'
import { createTokenMinter, type Minter } from './token-minter.js'

/** Where a connection keeps a value it was given, by connection id and slot. */
const slotName = (id: string, slot: ConnectionSlot): ConnectionSecretName => `connection:${id}:${slot}`

/** Mints the tokens of OAuth connections for every task, with the store's secrets. */
export const tokenMinter = createTokenMinter({
  fetch: async (input, init) => fetch(input, init),
  secret: async (name) => secret(name),
  rotate: async (name, expected, next) => sealedSecrets.replaceIf(name, expected, next),
  record: async (id, error) => connectionRows.recordMint(id, error),
  now: () => Date.now(),
})

/** What the token minter needs for an OAuth connection; null for a key. */
export function minterOf(row: ConnectionRow): Minter | null {
  if (row.kind === 'key' || row.mint === null) {
    return null
  }
  return {
    ...row.mint,
    grant: row.kind,
    client_id_secret: row.slots.client_id ?? null,
    client_secret: row.slots.client_secret ?? null,
    private_key: row.slots.private_key ?? null,
    refresh_token: row.slots.refresh_token ?? null,
    service_account: row.slots.key_file ?? null,
  }
}

/**
 * The value a connection stands for: its key, or a token minted for it. Throws when a mint
 * fails; null when the key is not set. Only the server and the proxy ever hold it.
 */
export async function connectionValue(row: ConnectionRow): Promise<string | null> {
  const minter = minterOf(row)
  if (minter !== null) {
    return (await tokenMinter.token(row.id, minter)).token
  }
  const name = row.slots.value
  return name === undefined ? null : ((await secret(name))?.trim() ?? null)
}

/** Drops stored values no connection holds any more, inside the caller's transaction. */
export async function dropUnused(db: Db, names: readonly StoredSecretName[]): Promise<void> {
  for (const name of new Set(names)) {
    if (!(await connectionRows.secretUsed(db, name))) {
      await sealedSecrets.remove(name, db)
    }
  }
}

/** Seals a value into the connection's own slot; a value it shared with another stays theirs. */
export async function storeValue(
  db: Db,
  row: Pick<ConnectionRow, 'id' | 'slots'>,
  slot: ConnectionSlot,
  value: string,
): Promise<void> {
  const name = slotName(row.id, slot)
  const before = row.slots[slot]
  await sealedSecrets.put(name, value, db)
  await connectionRows.setSlot(db, row.id, slot, name)
  if (before !== undefined && before !== name) {
    await dropUnused(db, [before])
  }
}

/** Clears one value of a connection; false when it had none. */
export async function clearValue(db: Db, row: ConnectionRow, slot: ConnectionSlot): Promise<boolean> {
  const before = row.slots[slot]
  if (before === undefined) {
    return false
  }
  await connectionRows.clearSlot(db, row.id, slot)
  await dropUnused(db, [before])
  return true
}

/** The references a poller may send: Default's GitHub tokens and every connection by name. */
export async function pollerSecretRefs(): Promise<string[]> {
  return [...(await githubPollerRefs()), ...(await connectionRows.list()).map((row) => row.name)]
}

async function refValue(ref: string): Promise<string | null> {
  const github = githubRefName(ref)
  if (github !== null) {
    return secret(github)
  }
  const row = await connectionRows.byName(ref)
  return row === undefined ? null : connectionValue(row)
}

/** The values behind a poller's references; throws naming the first one that is not set. */
export async function pollerSecretValues(refs: readonly string[]): Promise<Map<string, string>> {
  const values = new Map<string, string>()
  for (const ref of refs) {
    const value = await refValue(ref)
    if (value === null || value === '') {
      throw new Error(`The connection ${ref} has no value; set it in Settings, Connections`)
    }
    values.set(ref, value)
  }
  return values
}
