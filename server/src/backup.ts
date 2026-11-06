import { spawn } from 'node:child_process'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** Layout v1: magic, sender X25519 SPKI, recipient key fingerprint, nonce, ciphertext, tag. */
const MAGIC = Buffer.from('SETIBAK1')
const SPKI_LEN = 44
const FINGERPRINT_LEN = 8
const NONCE_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + SPKI_LEN + FINGERPRINT_LEN + NONCE_LEN
const HKDF_INFO = 'seti-backup-v1'

/** Backups are pg_dump custom-format archives; SQLite-era `.db.enc` files are left alone. */
const BACKUP_PATTERN = /^seti-\d{8}T\d{6}Z\.pgdump\.enc$/
const PRIVATE_KEY_VAR = 'SETI_BACKUP_PRIVATE_KEY'

const spki = (key: KeyObject) => key.export({ format: 'der', type: 'spki' })
const fingerprint = (publicSpki: Buffer) =>
  createHash('sha256').update(publicSpki).digest().subarray(0, FINGERPRINT_LEN)

function x25519(key: KeyObject, name: string): KeyObject {
  if (key.asymmetricKeyType !== 'x25519') {
    throw new Error(`${name} must be an X25519 key made by the backup keygen command`)
  }
  return key
}

/** The recipient key from SETI_BACKUP_PUBLIC_KEY: base64 of an X25519 SPKI DER key. */
export function readBackupPublicKey(value: string): KeyObject {
  try {
    return x25519(
      createPublicKey({ key: Buffer.from(value.trim(), 'base64'), format: 'der', type: 'spki' }),
      'SETI_BACKUP_PUBLIC_KEY',
    )
  } catch (e) {
    throw new Error(`SETI_BACKUP_PUBLIC_KEY is not a backup public key: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The private key from a key file holding a SETI_BACKUP_PRIVATE_KEY=<base64 PKCS8 DER> line. */
export function readBackupPrivateKey(file: string): KeyObject {
  const line = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith(`${PRIVATE_KEY_VAR}=`))
  if (line === undefined) {
    throw new Error(`${file} has no ${PRIVATE_KEY_VAR} line`)
  }
  const der = Buffer.from(line.slice(PRIVATE_KEY_VAR.length + 1).trim(), 'base64')
  return x25519(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), PRIVATE_KEY_VAR)
}

/** Writes a new private key file, owner-only, and returns the matching env line for seti.env. */
export function writeBackupKeyPair(privateKeyFile: string): string {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  fs.writeFileSync(privateKeyFile, `${PRIVATE_KEY_VAR}=${der}\n`, { mode: 0o600, flag: 'wx' })
  return `SETI_BACKUP_PUBLIC_KEY=${spki(publicKey).toString('base64')}`
}

function fileKey(shared: Buffer, senderSpki: Buffer, recipientSpki: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([senderSpki, recipientSpki]), HKDF_INFO, 32))
}

/** Encrypts a stream to `target` for the holder of the private half of `recipient`. */
async function encryptStream(source: Readable, target: string, recipient: KeyObject): Promise<void> {
  const sender = generateKeyPairSync('x25519')
  const senderSpki = spki(sender.publicKey)
  const recipientSpki = spki(recipient)
  const key = fileKey(diffieHellman({ privateKey: sender.privateKey, publicKey: recipient }), senderSpki, recipientSpki)
  const nonce = randomBytes(NONCE_LEN)
  const header = Buffer.concat([MAGIC, senderSpki, fingerprint(recipientSpki), nonce])
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(header)
  await pipeline(
    source,
    async function* (chunks: AsyncIterable<Buffer>) {
      yield header
      for await (const chunk of chunks) {
        yield cipher.update(chunk)
      }
      yield cipher.final()
      yield cipher.getAuthTag()
    },
    fs.createWriteStream(target, { mode: 0o600, flags: 'wx' }),
  )
}

async function readHeader(source: string): Promise<{ header: Buffer; tag: Buffer; size: number }> {
  const handle = await fs.promises.open(source, 'r')
  try {
    const { size } = await handle.stat()
    if (size < HEADER_LEN + TAG_LEN) {
      throw new Error('The file is too short to be a Seti backup')
    }
    const header = Buffer.alloc(HEADER_LEN)
    const tag = Buffer.alloc(TAG_LEN)
    await handle.read(header, 0, HEADER_LEN, 0)
    await handle.read(tag, 0, TAG_LEN, size - TAG_LEN)
    return { header, tag, size }
  } finally {
    await handle.close()
  }
}

/** Decrypts a backup to `target`, which exists only once the whole file has authenticated. */
export async function decryptFile(source: string, target: string, privateKey: KeyObject): Promise<void> {
  const { header, tag, size } = await readHeader(source)
  if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Not a Seti backup, or a version this Seti cannot read')
  }
  const senderSpki = header.subarray(MAGIC.length, MAGIC.length + SPKI_LEN)
  const recipientSpki = spki(createPublicKey(privateKey))
  if (!header.subarray(MAGIC.length + SPKI_LEN, HEADER_LEN - NONCE_LEN).equals(fingerprint(recipientSpki))) {
    throw new Error('This backup was encrypted for another key')
  }
  const sender = createPublicKey({ key: senderSpki, format: 'der', type: 'spki' })
  const key = fileKey(diffieHellman({ privateKey, publicKey: sender }), senderSpki, recipientSpki)
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(HEADER_LEN - NONCE_LEN))
  decipher.setAAD(header)
  decipher.setAuthTag(tag)
  const partial = `${target}.partial`
  try {
    await pipeline(
      fs.createReadStream(source, { start: HEADER_LEN, end: size - TAG_LEN - 1 }),
      async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          yield decipher.update(chunk)
        }
        yield decipher.final()
      },
      fs.createWriteStream(partial, { mode: 0o600, flags: 'wx' }),
    )
  } catch (e) {
    fs.rmSync(partial, { force: true })
    const failedAuth = e instanceof Error && /authenticate/i.test(e.message)
    throw failedAuth ? new Error('The backup failed authentication: it was changed or is damaged') : e
  }
  fs.renameSync(partial, target)
}

const stamp = (at: Date) =>
  at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')

/** Backups in `dir`, oldest first; the timestamp in the name sorts them. */
export function listBackups(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs
    .readdirSync(dir)
    .filter((name) => BACKUP_PATTERN.test(name))
    .sort((a, b) => a.localeCompare(b))
}

function rotate(dir: string, keep: number): string[] {
  const backups = listBackups(dir)
  const removed = backups.slice(0, Math.max(0, backups.length - keep))
  for (const name of removed) {
    fs.rmSync(path.join(dir, name), { force: true })
  }
  return removed
}

interface BackupOptions {
  dir: string
  recipient: KeyObject
  keep: number
  at?: Date
}

interface BackupResult {
  file: string
  bytes: number
  removed: string[]
}

function runTool(command: string, args: readonly string[]): { stdout: Readable; done: Promise<void> } {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const errors: Buffer[] = []
  child.stderr.on('data', (chunk: Buffer) => errors.push(chunk))
  const done = once(child, 'close').then(([code]) => {
    if (code !== 0) {
      const detail = Buffer.concat(errors).toString('utf8').trim()
      const reason = detail === '' ? '' : `: ${detail}`
      throw new Error(`${command} exited with ${String(code)}${reason}`)
    }
  })
  return { stdout: child.stdout, done }
}

/** A consistent dump of the database; the plaintext never touches the disk. */
async function dumpDatabase(url: string, target: string, recipient: KeyObject): Promise<void> {
  const dump = runTool('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--dbname=${url}`])
  const [encrypted, exited] = await Promise.allSettled([encryptStream(dump.stdout, target, recipient), dump.done])
  if (exited.status === 'rejected') {
    throw exited.reason
  }
  if (encrypted.status === 'rejected') {
    throw encrypted.reason
  }
}

export async function restoreDump(file: string, url: string): Promise<void> {
  const restore = runTool('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', `--dbname=${url}`, file])
  restore.stdout.resume()
  await restore.done
}

/** Dumps the database with pg_dump into the backup encryption and rotates old copies. */
export async function backupDatabase(url: string, options: BackupOptions): Promise<BackupResult> {
  const { dir, recipient, keep, at = new Date() } = options
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = `seti-${stamp(at)}.pgdump.enc`
  const partial = path.join(dir, `.${name}.partial`)
  try {
    await dumpDatabase(url, partial, recipient)
    fs.renameSync(partial, path.join(dir, name))
  } finally {
    fs.rmSync(partial, { force: true })
  }
  const file = path.join(dir, name)
  return { file, bytes: fs.statSync(file).size, removed: rotate(dir, keep) }
}

/** Milliseconds until the next backup is due, given when the newest one was written. */
export function nextBackupDelay(newestMs: number | null, nowMs: number, intervalMs: number): number {
  return newestMs === null ? 0 : Math.max(0, newestMs + intervalMs - nowMs)
}
