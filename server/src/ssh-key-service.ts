import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import type { SshKey, SshKeySource } from '@seti/shared'
import { audit } from './audit.js'
import { HttpError } from './http.js'
import { sealedSecrets } from './secrets.js'
import { keyFilePath, keySecret } from './ssh-files.js'
import { generateEd25519, inspectPrivateKey, type SshKeyPair } from './ssh-keys.js'
import { keyView, sshChanged } from './ssh.js'
import { sshHostStore, sshKeys, type SshKeyMaterial, type SshKeyRow } from './store/ssh.js'

/** Where a key's private half comes from: pasted or generated text, or a file on this machine. */
type KeySourceInput = { private_key: string } | { path: string }

async function inspect(privateKey: string, comment: string): Promise<SshKeyPair> {
  try {
    return await inspectPrivateKey(privateKey, comment)
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : 'That is not a private key')
  }
}

async function readKeyFile(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(keyFilePath(file), 'utf8')
  } catch {
    throw new HttpError(400, `Seti cannot read ${file}`)
  }
}

async function pairOf(input: KeySourceInput, comment: string): Promise<{ pair: SshKeyPair; source: SshKeySource }> {
  if ('path' in input) {
    return { pair: await inspect(await readKeyFile(input.path), comment), source: 'file' }
  }
  return { pair: await inspect(input.private_key, comment), source: 'imported' }
}

async function refuseDuplicate(fingerprint: string, except: string | null = null): Promise<void> {
  if ((await sshKeys.list()).some((key) => key.fingerprint === fingerprint && key.id !== except)) {
    throw new HttpError(409, `Seti already has the key ${fingerprint}`)
  }
}

const materialOf = (pair: SshKeyPair, source: SshKeySource, file: string | null): SshKeyMaterial => ({
  type: pair.type,
  public_key: pair.publicKey,
  fingerprint: pair.fingerprint,
  source,
  path: source === 'file' ? file : null,
})

/** Seals a pasted or generated private key; a key file stays where it is and is read when needed. */
async function keepPrivate(id: string, pair: SshKeyPair, source: SshKeySource): Promise<void> {
  await (source === 'file' ? sealedSecrets.remove(keySecret(id)) : sealedSecrets.put(keySecret(id), pair.privateKey))
}

async function store(name: string, pair: SshKeyPair, source: SshKeySource, file: string | null): Promise<SshKey> {
  await refuseDuplicate(pair.fingerprint)
  const at = new Date().toISOString()
  const key: SshKeyRow = { id: randomUUID(), name, ...materialOf(pair, source, file), created_at: at, updated_at: at }
  await keepPrivate(key.id, pair, source)
  await sshKeys.insert(key)
  const verb = { generated: 'Generated', imported: 'Imported', file: `Added from ${file ?? ''}` }[source]
  await audit.record({
    actor: 'user',
    kind: 'system.ssh_key_added',
    subject_type: 'system',
    subject_id: key.id,
    summary: `${verb} the ssh key ${key.name}`,
    detail: { name: key.name, fingerprint: key.fingerprint, source, path: key.path },
  })
  return keyView(key, [])
}

async function requireKey(id: string): Promise<SshKeyRow> {
  const key = await sshKeys.get(id)
  if (key === undefined) {
    throw new HttpError(404, 'No such ssh key')
  }
  return key
}

const usersOf = async (id: string) =>
  (await sshHostStore.list()).filter((host) => host.key_id === id).map((host) => host.alias)

interface KeyChange {
  name?: string | undefined
  private_key?: string | undefined
  path?: string | undefined
}

function sourceOf(change: KeyChange): KeySourceInput | null {
  if (change.path !== undefined) {
    return { path: change.path }
  }
  return change.private_key === undefined ? null : { private_key: change.private_key }
}

export const sshKeyService = {
  generate: async (name: string, comment = name): Promise<SshKey> =>
    store(name, generateEd25519(comment), 'generated', null),
  import: async (name: string, privateKey: string, comment = name): Promise<SshKey> =>
    store(name, await inspect(privateKey, comment), 'imported', null),
  file: async (name: string, file: string): Promise<SshKey> => {
    const { pair } = await pairOf({ path: file }, name)
    return store(name, pair, 'file', file)
  },
  /** Renames a key or swaps its private half; every host that uses it logs in with the new one. */
  update: async (id: string, change: KeyChange): Promise<SshKey> => {
    const before = await requireKey(id)
    const name = change.name ?? before.name
    const source = sourceOf(change)
    const changes = name === before.name ? [] : [`name: ${before.name} -> ${name}`]
    if (source !== null) {
      const { pair, source: kind } = await pairOf(source, name)
      await refuseDuplicate(pair.fingerprint, id)
      await keepPrivate(id, pair, kind)
      await sshKeys.replace(id, materialOf(pair, kind, 'path' in source ? source.path : null))
      changes.push(`key: ${before.fingerprint} -> ${pair.fingerprint}`)
    }
    if (name !== before.name) {
      await sshKeys.rename(id, name)
    }
    const hosts = await usersOf(id)
    if (changes.length > 0) {
      await audit.record({
        actor: 'user',
        kind: 'system.ssh_key_changed',
        subject_type: 'system',
        subject_id: id,
        summary: `Changed the ssh key ${name}: ${changes.join('; ')}`,
        detail: { name, changes, hosts },
      })
      await sshChanged()
    }
    return keyView(await requireKey(id), await sshHostStore.list())
  },
  /** Removes a key no host uses; 409 naming the hosts otherwise. */
  remove: async (id: string): Promise<SshKey | null> => {
    const key = await sshKeys.get(id)
    if (key === undefined) {
      return null
    }
    const hosts = await usersOf(id)
    if (hosts.length > 0) {
      throw new HttpError(
        409,
        `${hosts.join(', ')} ${hosts.length === 1 ? 'uses' : 'use'} ${key.name}; choose another key there first`,
      )
    }
    await sshKeys.delete(id)
    await sealedSecrets.remove(keySecret(id))
    await audit.record({
      actor: 'user',
      kind: 'system.ssh_key_removed',
      subject_type: 'system',
      subject_id: key.id,
      summary: `Removed the ssh key ${key.name}`,
      detail: { name: key.name, fingerprint: key.fingerprint },
    })
    await sshChanged()
    return keyView(key, [])
  },
}
