import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { SshCheck, SshKnownHost, SshLogin, SshScannedKey } from '@seti/shared'
import { findBinary } from './binaries.js'
import { SETI_HOME } from './config.js'
import { HttpError } from './http.js'
import { sshAgentSocket, stopSshAgent } from './ssh-agent.js'
import { hostMap, knownName, sandboxSshConfig, sshChain } from './ssh-config.js'
import { hostKeys, knownHostsText, renderHosts, writeKeyFiles } from './ssh-files.js'
import { publicKeyInfo } from './ssh-keys.js'
import { sshChanged } from './ssh.js'
import { sshHostStore, sshKeys, sshKnownHosts, type KnownHostRow, type SshHostRow } from './store/ssh.js'

const exec = promisify(execFile)

const SCAN_TIMEOUT_MS = 30_000
const KNOWN_HOST = /^(?:[\w.-]+|\[[\w.-]+\]:\d{1,5})$/
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-[\w.@-]+)$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

interface KeyLine {
  host: string
  type: string
  key: string
}

function parseKeyLine(line: string): KeyLine | null {
  const [host = '', type = '', key = '', ...rest] = line.trim().split(/\s+/)
  const valid = KNOWN_HOST.test(host) && KEY_TYPE.test(type) && BASE64.test(key) && rest.length === 0
  return valid ? { host, type, key } : null
}

async function keyscan(host: string, port: number): Promise<string[]> {
  const { stdout } = await exec(findBinary('ssh-keyscan'), ['-T', '10', '-p', String(port), host], {
    timeout: SCAN_TIMEOUT_MS,
  }).catch(() => ({ stdout: '' }))
  return stdout.split('\n')
}

/** What a login attempt found: the host keys ssh learned and whether the host's key got in. */
interface Probe {
  found: string[]
  login: SshLogin
}

/** The line of ssh's stderr that says why a login failed, without its notes on added host keys. */
function loginFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'ssh could not log in'
  }
  if ('killed' in error && error.killed === true) {
    return 'Timed out'
  }
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  const said = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Warning: Permanently added'))
    .at(-1)
  return said?.slice(0, 300) ?? 'ssh could not log in'
}

/**
 * Logs in to the first host of `chain` with its user and key, through its jump hosts, whose host
 * keys must be trusted already; the target's host keys are learned on the way, never trusted.
 */
async function probeLogin(chain: readonly SshHostRow[], keyName: string): Promise<Probe> {
  const [target, ...jumps] = chain
  if (target === undefined) {
    return { found: [], login: { ok: false, detail: 'No such host' } }
  }
  const dir = path.join(SETI_HOME, 'sandbox', `ssh-check-${randomBytes(6).toString('hex')}`)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const agentId = `check-${path.basename(dir)}`
  try {
    const known = path.join(dir, 'known_hosts')
    const found = path.join(dir, 'found')
    fs.writeFileSync(known, await knownHostsText(new Set(jumps.map(knownName))), { mode: 0o600 })
    await writeKeyFiles(dir, chain)
    const relaxed = [`Host ${target.alias}`, '  StrictHostKeyChecking accept-new', `  UserKnownHostsFile ${found}`, '']
    const config = sandboxSshConfig(renderHosts(chain, dir), { proxy: null, knownHosts: known, first: relaxed })
    fs.writeFileSync(path.join(dir, 'config'), config, { mode: 0o600 })
    const socket = await sshAgentSocket(agentId, path.join(dir, 'agent'), async () => hostKeys(chain))
    const env = { PATH: process.env.PATH ?? '', HOME: dir, SSH_AUTH_SOCK: socket }
    const args = ['-F', path.join(dir, 'config'), '-o', 'ConnectTimeout=10', target.alias, 'true']
    const login = await exec(findBinary('ssh'), args, { env, timeout: SCAN_TIMEOUT_MS }).then(
      () => ({ ok: true, detail: `Logged in as ${target.user} with ${keyName}` }),
      (e: unknown) => ({ ok: false, detail: loginFailure(e) }),
    )
    return { found: fs.existsSync(found) ? fs.readFileSync(found, 'utf8').split('\n') : [], login }
  } finally {
    await stopSshAgent(agentId)
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function scannedKey(line: KeyLine, accepted: readonly KnownHostRow[]): Promise<SshScannedKey> {
  const { fingerprint } = await publicKeyInfo(`${line.type} ${line.key}`)
  const known = accepted.some(
    (row) => row.host === line.host && row.key_type === line.type && row.public_key === line.key,
  )
  return { line: `${line.host} ${line.type} ${line.key}`, host: line.host, key_type: line.type, fingerprint, known }
}

/**
 * Checks a host from this machine, never a sandbox: the host keys it offers, none trusted until
 * accepted, and a login with its key. A host without a key, or behind one, is not contacted.
 */
export async function checkHost(alias: string): Promise<SshCheck> {
  const chain = sshChain(hostMap(await sshHostStore.list()), alias)
  const [target] = chain
  if (target === undefined) {
    throw new HttpError(404, `No ssh host ${alias}`)
  }
  const keyless = chain.find((host) => host.key_id === null)
  if (keyless !== undefined) {
    const whose = keyless === target ? alias : `its jump host ${keyless.alias}`
    throw new HttpError(409, `Choose a key for ${whose} before checking ${alias}`)
  }
  const key = target.key_id === null ? undefined : await sshKeys.get(target.key_id)
  const [probe, scanned] = await Promise.all([
    probeLogin(chain, key?.name ?? 'its key'),
    chain.length === 1 ? keyscan(target.hostname, target.port) : Promise.resolve(null),
  ])
  const expected = knownName(target)
  const parsed = (scanned ?? probe.found).flatMap((line) => {
    const entry = line.startsWith('#') ? null : parseKeyLine(line)
    return entry?.host.toLowerCase() === expected ? [entry] : []
  })
  const accepted = await sshKnownHosts.list()
  const keys = await Promise.all(parsed.map(async (line) => scannedKey(line, accepted)))
  return { alias, keys, login: probe.login }
}

/** Trusts host keys the user accepted, as known_hosts lines; returns what was stored. */
export async function acceptHostKeys(lines: readonly string[]): Promise<SshKnownHost[]> {
  const stored: SshKnownHost[] = []
  for (const text of lines) {
    const line = parseKeyLine(text)
    if (line === null) {
      throw new HttpError(400, 'Each entry must be a known_hosts line: host, key type and key')
    }
    const { fingerprint } = await publicKeyInfo(`${line.type} ${line.key}`).catch(() => {
      throw new HttpError(400, `The ${line.type} key for ${line.host} is not a valid public key`)
    })
    await sshKnownHosts.put({ host: line.host, key_type: line.type, public_key: line.key, fingerprint })
    stored.push({ host: line.host, key_type: line.type, fingerprint, accepted_at: new Date().toISOString() })
  }
  await sshChanged()
  return stored
}
