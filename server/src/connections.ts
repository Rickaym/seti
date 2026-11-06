import { randomBytes, randomUUID } from 'node:crypto'
import {
  envFor,
  firstFree,
  KIND_SLOTS,
  neededSlots,
  type AuditActor,
  type AuditDetail,
  type AuditKind,
  type Connection,
  type ConnectionCreateRequest,
  type ConnectionPlaceholderRequest,
  type ConnectionRequest,
  type ConnectionSlot,
  type MintTest,
} from '@seti/shared'
import { audit } from './audit.js'
import { clearValue, dropUnused, minterOf, storeValue, tokenMinter } from './connection-values.js'
import { transaction } from './db.js'
import { HttpError } from './http.js'
import { keyFileProblem } from './jwt-keys.js'
import { connectionRows, type ConnectionRow, type ConnectionSettings } from './store/connections.js'
import { profiles } from './store/credentials.js'
import { pollerStore } from './store/pollers.js'
import { secretRows } from './store/secrets.js'
import { MintError } from './token-minter.js'

/** What agents see in a connection's variable: unguessable, the same for its whole life. */
const newPlaceholder = (name: string) => `seti-secret-${name}-${randomBytes(16).toString('hex')}`

async function view(row: ConnectionRow): Promise<Connection> {
  const names = Object.values(row.slots)
  const [stamps, carriers, pollers] = await Promise.all([
    secretRows.stamps(names),
    connectionRows.profilesOf(row.id),
    pollerStore.usingSecret(row.name),
  ])
  const slots = KIND_SLOTS[row.kind].map((slot) => {
    const name = row.slots[slot]
    const at = name === undefined ? null : (stamps.get(name) ?? null)
    return { slot, set: at !== null, updated_at: at }
  })
  const set = new Set(slots.filter((slot) => slot.set).map((slot) => slot.slot))
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    env: row.env,
    hosts: row.hosts,
    header: row.header,
    mint: row.mint,
    mint_error: row.mint_error,
    mint_checked_at: row.mint_checked_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    slots,
    missing: neededSlots(row.kind, row.mint).filter((slot) => !set.has(slot)),
    profiles: carriers,
    pollers,
  }
}

async function requireConnection(id: string): Promise<ConnectionRow> {
  const row = await connectionRows.get(id)
  if (row === undefined) {
    throw new HttpError(404, 'No such connection')
  }
  return row
}

export async function listConnections(): Promise<Connection[]> {
  return Promise.all((await connectionRows.list()).map(view))
}

export async function getConnection(id: string): Promise<Connection> {
  return view(await requireConnection(id))
}

interface ConnectionAudit {
  kind: AuditKind
  row: { id: string; name: string }
  summary: string
  detail: AuditDetail
  actor?: AuditActor
}

/** Names, kinds, hosts and credentials only: never a value or a token. */
async function auditConnection({ kind, row, summary, detail, actor = 'user' }: ConnectionAudit): Promise<void> {
  await audit.record({
    actor,
    kind,
    subject_type: 'connection',
    subject_id: row.id,
    summary,
    detail: { connection: row.name, ...detail },
  })
}

const settingsLine = (settings: ConnectionSettings): AuditDetail => ({
  kind: settings.kind,
  env: settings.env,
  hosts: [...settings.hosts],
  header: settings.header?.name ?? null,
  token_url: settings.mint?.token_url ?? null,
  scope: settings.mint?.scope ?? null,
})

const unique = (e: unknown) => typeof e === 'object' && e !== null && 'code' in e && e.code === '23505'

async function assertFree(settings: ConnectionSettings, except: string | null): Promise<void> {
  const named = await connectionRows.byName(settings.name)
  if (named !== undefined && named.id !== except) {
    throw new HttpError(409, `A connection named ${settings.name} already exists`)
  }
  const holder = await connectionRows.envTaken(settings.env, except)
  if (holder !== null) {
    throw new HttpError(409, `The connection ${holder} already uses ${settings.env}; pick another variable`)
  }
}

async function profileNames(ids: readonly string[]): Promise<string[]> {
  const known = new Map((await profiles.list()).map((profile) => [profile.id, profile.name]))
  return ids.map((id) => {
    const name = known.get(id)
    if (name === undefined) {
      throw new HttpError(404, 'No such credential')
    }
    return name
  })
}

async function insert(
  settings: ConnectionSettings,
  values: Partial<Record<ConnectionSlot, string>>,
  profileIds: readonly string[],
): Promise<ConnectionRow> {
  const id = randomUUID()
  try {
    await transaction(async (tx) => {
      await connectionRows.insert(tx, id, settings, newPlaceholder(settings.name))
      for (const slot of KIND_SLOTS[settings.kind]) {
        const value = values[slot]
        if (value !== undefined) {
          await storeValue(tx, { id, slots: {} }, slot, value)
        }
      }
      await connectionRows.setProfiles(tx, id, profileIds)
      await connectionRows.touchProfiles(tx, profileIds)
    })
  } catch (e) {
    throw unique(e) ? new HttpError(409, `A connection named ${settings.name} already exists`) : e
  }
  return requireConnection(id)
}

/** Adds a connection with any values given and the credentials that carry it, in one step. */
export async function createConnection(input: ConnectionCreateRequest): Promise<Connection> {
  const { values, profile_ids: profileIds, ...settings } = input
  checkValues(values)
  await assertFree(settings, null)
  const carriers = await profileNames(profileIds)
  const row = await insert(settings, values, profileIds)
  await auditConnection({
    kind: 'system.connection_created',
    row,
    summary: `Added the connection ${row.name} for ${hostsText(row)}`,
    detail: { ...settingsLine(row), credentials: carriers, values: Object.keys(values) },
  })
  return view(row)
}

const hostsText = (row: { hosts: readonly string[] }) => (row.hosts.length === 0 ? 'no hosts' : row.hosts.join(', '))

/** Derives a free variable for a requested connection from its name. */
async function freeEnv(name: string): Promise<string> {
  const taken = new Set((await connectionRows.list()).map((row) => row.env))
  return firstFree(envFor(name), (env) => !taken.has(env))
}

/**
 * Adds a connection the user fills in later, as an approved agent request does: a key the agent
 * sends, or one Seti adds as a bearer header. It starts with no value and in no credential.
 */
export async function createConnectionPlaceholder(
  request: ConnectionPlaceholderRequest,
  actor: AuditActor,
): Promise<Connection> {
  const settings: ConnectionSettings = {
    name: request.name,
    kind: 'key',
    env: request.env ?? (await freeEnv(request.name)),
    hosts: request.hosts,
    header: request.adds_header ? { name: 'Authorization', template: 'Bearer {{value}}' } : null,
    mint: null,
  }
  await assertFree(settings, null)
  const row = await insert(settings, {}, [])
  await auditConnection({
    kind: 'system.connection_created',
    row,
    summary: `Added the connection ${row.name} for ${hostsText(row)}, waiting for its value`,
    detail: settingsLine(row),
    actor,
  })
  return view(row)
}

const sameSettings = (a: ConnectionSettings, b: ConnectionSettings) =>
  JSON.stringify([a.env, a.hosts, a.header, a.mint]) === JSON.stringify([b.env, b.hosts, b.header, b.mint])

/** Changes a connection's settings; its values, placeholder and credentials stay. */
export async function updateConnection(id: string, input: ConnectionRequest): Promise<Connection> {
  const before = await requireConnection(id)
  if (input.kind !== before.kind) {
    throw new HttpError(409, 'A connection keeps its kind; add a new one instead')
  }
  if (input.name !== before.name && (await pollerStore.usingSecret(before.name)).length > 0) {
    throw new HttpError(409, `Pollers send ${before.name} by name; change them before renaming it`)
  }
  await assertFree(input, id)
  const carriers = await connectionRows.profilesOf(id)
  await transaction(async (tx) => {
    await connectionRows.update(tx, id, input)
    if (!sameSettings(before, input)) {
      await connectionRows.touchProfiles(
        tx,
        carriers.map((profile) => profile.id),
      )
    }
  })
  const after = await requireConnection(id)
  await auditConnection({
    kind: 'system.connection_changed',
    row: after,
    summary: `Changed the connection ${after.name}`,
    detail: { change: 'settings', ...settingsLine(after), previous_env: before.env, previous_hosts: before.hosts },
  })
  return view(after)
}

/** Deletes a connection and the values only it held; pollers that send it must change first. */
export async function deleteConnection(id: string): Promise<void> {
  const row = await requireConnection(id)
  const pollers = await pollerStore.usingSecret(row.name)
  if (pollers.length > 0) {
    throw new HttpError(409, `The pollers ${pollers.join(', ')} send ${row.name}; change them first`)
  }
  const carriers = await connectionRows.profilesOf(id)
  await transaction(async (tx) => {
    await connectionRows.touchProfiles(
      tx,
      carriers.map((profile) => profile.id),
    )
    await connectionRows.remove(tx, id)
    await dropUnused(tx, Object.values(row.slots))
  })
  await auditConnection({
    kind: 'system.connection_deleted',
    row,
    summary: `Deleted the connection ${row.name}`,
    detail: { ...settingsLine(row), credentials: carriers.map((profile) => profile.name) },
  })
}

function requireSlot(row: ConnectionRow, slot: ConnectionSlot): void {
  if (!KIND_SLOTS[row.kind].includes(slot)) {
    throw new HttpError(400, `A ${row.kind} connection has no ${slot}`)
  }
}

/** Refuses a key file Seti could not sign with, naming why but never the value. */
function checkValues(values: Partial<Record<ConnectionSlot, string>>): void {
  const keyFile = values.key_file
  const problem = keyFile === undefined ? null : keyFileProblem(keyFile)
  if (problem !== null) {
    throw new HttpError(400, problem)
  }
}

/** Sets one value of a connection; the value never comes back. */
export async function setConnectionValue(id: string, slot: ConnectionSlot, value: string): Promise<Connection> {
  const row = await requireConnection(id)
  requireSlot(row, slot)
  checkValues({ [slot]: value })
  await transaction(async (tx) => {
    await storeValue(tx, row, slot, value)
    await connectionRows.touch(tx, id)
  })
  await auditConnection({
    kind: 'system.secret_set',
    row,
    summary: `Set the ${slot} of the connection ${row.name}`,
    detail: { slot },
  })
  return getConnection(id)
}

export async function clearConnectionValue(id: string, slot: ConnectionSlot): Promise<Connection> {
  const row = await requireConnection(id)
  requireSlot(row, slot)
  const cleared = await transaction(async (tx) => clearValue(tx, row, slot))
  if (cleared) {
    await auditConnection({
      kind: 'system.secret_cleared',
      row,
      summary: `Cleared the ${slot} of the connection ${row.name}`,
      detail: { slot },
    })
  }
  return getConnection(id)
}

/** Carries the connection in exactly these credentials; their agents restart at the next turn. */
export async function setConnectionProfiles(id: string, profileIds: readonly string[]): Promise<Connection> {
  const row = await requireConnection(id)
  const wanted = [...new Set(profileIds)]
  const names = await profileNames(wanted)
  const before = await connectionRows.profilesOf(id)
  const added = wanted.filter((profile) => !before.some((entry) => entry.id === profile))
  const removed = before.filter((entry) => !wanted.includes(entry.id))
  if (added.length === 0 && removed.length === 0) {
    return view(row)
  }
  await transaction(async (tx) => {
    await connectionRows.setProfiles(tx, id, wanted)
    await connectionRows.touchProfiles(tx, [...added, ...removed.map((entry) => entry.id)])
  })
  const text = names.length === 0 ? 'no credential' : names.join(', ')
  await auditConnection({
    kind: 'system.connection_changed',
    row,
    summary: `${row.name} is now in ${text}`,
    detail: {
      change: 'credentials',
      credentials: names,
      added: names.filter((_name, i) => added.includes(wanted[i] ?? '')),
      removed: removed.map((entry) => entry.name),
    },
  })
  return getConnection(id)
}

/** Mints one token for an OAuth connection and reports what it grants; the token never leaves. */
export async function testConnectionMint(id: string): Promise<MintTest> {
  const row = await requireConnection(id)
  const minter = minterOf(row)
  if (minter === null) {
    throw new HttpError(409, 'Only OAuth connections mint tokens')
  }
  try {
    const minted = await tokenMinter.test(row.id, minter)
    return {
      ok: true,
      error: null,
      expires_at: new Date(minted.expiresAt).toISOString(),
      scope: minted.scope,
      token_type: minted.tokenType,
    }
  } catch (e) {
    const error = e instanceof MintError ? e.message : 'the mint failed'
    return { ok: false, error, expires_at: null, scope: null, token_type: null }
  }
}
