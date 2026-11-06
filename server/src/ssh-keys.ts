import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { findBinary } from './binaries.js'

/** A key pair as Seti stores it: the private key sealed, the rest shown to the user. */
export interface SshKeyPair {
  privateKey: string
  publicKey: string
  type: string
  fingerprint: string
}

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}

const sshString = (value: Buffer | string) => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value
  return Buffer.concat([u32(bytes.length), bytes])
}

const fingerprintOf = (blob: Buffer) =>
  `SHA256:${createHash('sha256').update(blob).digest('base64').replaceAll('=', '')}`

function wrap(base64: string): string {
  const lines = base64.match(/.{1,70}/g) ?? []
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', ...lines, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n')
}

/** A new ed25519 key in OpenSSH's unencrypted format, made in memory and never written to disk. */
export function generateEd25519(comment: string): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x ?? '', 'base64url')
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url')
  const type = 'ssh-ed25519'
  const blob = Buffer.concat([sshString(type), sshString(pub)])
  const check = randomBytes(4)
  const body = Buffer.concat([
    check,
    check,
    sshString(type),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(comment),
  ])
  const padding = Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, index) => index + 1))
  const key = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    u32(1),
    sshString(blob),
    sshString(Buffer.concat([body, padding])),
  ])
  return {
    privateKey: wrap(key.toString('base64')),
    publicKey: `${type} ${blob.toString('base64')} ${comment}`,
    type,
    fingerprint: fingerprintOf(blob),
  }
}

/** Runs an OpenSSH tool with `input` on stdin; rejects with a message that never quotes it. */
async function withStdin(tool: string, args: readonly string[], input: string, env = process.env): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(findBinary(tool), args, { stdio: ['pipe', 'pipe', 'ignore'], env })
    let out = ''
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out)
      } else {
        reject(new Error(`${tool} exited with ${String(code)}`))
      }
    })
    // A tool that exits before reading stdin breaks the pipe; its exit code decides the outcome.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/** The fingerprint and type of a public key line, as `ssh-keygen -l` prints them. */
export async function publicKeyInfo(line: string): Promise<{ type: string; fingerprint: string }> {
  const [bits, fingerprint = '', ...rest] = (await withStdin('ssh-keygen', ['-l', '-f', '-'], `${line}\n`))
    .trim()
    .split(' ')
  const type = rest.at(-1)?.replace(/[()]/g, '') ?? ''
  if (bits === undefined || !fingerprint.startsWith('SHA256:')) {
    throw new Error('not a public key')
  }
  return { type: type.toLowerCase(), fingerprint }
}

/**
 * Checks a pasted private key: it must be unencrypted and readable by OpenSSH. Returns its public
 * key and fingerprint; the error never quotes the key. ssh-keygen cannot open the socket Node
 * gives a child as stdin, so a shell pipe hands the key over.
 */
export async function inspectPrivateKey(privateKey: string, comment: string): Promise<SshKeyPair> {
  let publicLine: string
  const script = 'cat | "$0" -y -P "" -f /dev/stdin'
  try {
    publicLine = (await withStdin('sh', ['-c', script, findBinary('ssh-keygen')], `${privateKey.trim()}\n`)).trim()
  } catch {
    throw new Error('That is not an unencrypted OpenSSH or PEM private key')
  }
  const [type = '', base64 = ''] = publicLine.split(' ')
  const { fingerprint } = await publicKeyInfo(publicLine)
  return { privateKey: `${privateKey.trim()}\n`, publicKey: `${type} ${base64} ${comment}`, type, fingerprint }
}

/** Loads a private key into an agent over stdin, so it never touches the disk. */
export async function addToAgent(socket: string, privateKey: string): Promise<void> {
  await withStdin('ssh-add', ['-q', '-'], privateKey, { ...process.env, SSH_AUTH_SOCK: socket })
}

export async function clearAgent(socket: string): Promise<void> {
  await withStdin('ssh-add', ['-q', '-D'], '', { ...process.env, SSH_AUTH_SOCK: socket }).catch(() => undefined)
}
