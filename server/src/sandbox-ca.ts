import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { promisify } from 'node:util'
import { findBinary } from './binaries.js'

const exec = promisify(execFile)

/** Where Debian, Ubuntu, Fedora and Alpine keep the system CA bundle. */
const SYSTEM_BUNDLES = ['/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt', '/etc/ssl/cert.pem']

/** The first CA can only sign names under these, so its key is useless for any other site. */
const PERMITTED_DOMAINS = ['github.com', 'anthropic.com']

const CA_DAYS = '3650'
const LEAF_DAYS = '397'

export interface SandboxCa {
  /** Holds ca.pem and bundle.pem, the only CA files a sandbox mounts. */
  publicDir: string
  /** The system bundle a sandbox sees replaced by bundle.pem, or null when the host has none. */
  systemBundle: string | null
  /** A TLS context presenting a certificate for the host; rejects for hosts no CA may sign. */
  contextFor: (host: string) => Promise<tls.SecureContext>
  /**
   * Adds a CA constrained to the hosts no existing CA may sign, leaving the others untouched so
   * running sandboxes keep trusting what they trust; true when it added one.
   */
  cover: (hosts: readonly string[]) => Promise<boolean>
  covers: (host: string) => boolean
}

interface Authority {
  dir: string
  permitted: readonly string[]
}

async function openssl(args: readonly string[]): Promise<string> {
  const { stdout } = await exec(findBinary('openssl'), args, { timeout: 30_000 })
  return stdout
}

async function createCa(dir: string, permitted: readonly string[]): Promise<void> {
  const constraints = permitted.map((domain) => `permitted;DNS:${domain}`).join(',')
  const key = path.join(dir, 'ca.key')
  await openssl([
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    key,
    '-out',
    path.join(dir, 'ca.pem'),
    '-days',
    CA_DAYS,
    '-subj',
    '/O=Seti/CN=Seti sandbox egress CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-addext',
    `nameConstraints=critical,${constraints}`,
  ])
  fs.chmodSync(key, 0o600)
}

async function leafCertificate(leafKey: string, ca: Authority, host: string): Promise<string> {
  return openssl([
    'req',
    '-new',
    '-x509',
    '-key',
    leafKey,
    '-CA',
    path.join(ca.dir, 'ca.pem'),
    '-CAkey',
    path.join(ca.dir, 'ca.key'),
    '-subj',
    `/CN=${host}`,
    '-addext',
    `subjectAltName=DNS:${host}`,
    '-addext',
    'basicConstraints=critical,CA:FALSE',
    '-addext',
    'keyUsage=critical,digitalSignature',
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-days',
    LEAF_DAYS,
  ])
}

const permits = (ca: Authority, host: string) =>
  ca.permitted.some((domain) => host === domain || host.endsWith(`.${domain}`))

/** A host name a certificate may carry: letters, digits, dots and hyphens only. */
const VALID_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

function readExtras(root: string): Authority[] {
  const extra = path.join(root, 'extra')
  if (!fs.existsSync(extra)) {
    return []
  }
  return fs
    .readdirSync(extra)
    .toSorted((a, b) => a.localeCompare(b, 'en'))
    .flatMap((name) => {
      const dir = path.join(extra, name)
      try {
        const permitted: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'hosts.json'), 'utf8'))
        const complete = fs.existsSync(path.join(dir, 'ca.key')) && fs.existsSync(path.join(dir, 'ca.pem'))
        return complete && Array.isArray(permitted) ? [{ dir, permitted: permitted.map(String) }] : []
      } catch {
        return []
      }
    })
}

function replaceFile(file: string, text: string): void {
  const next = `${file}.next`
  fs.writeFileSync(next, text, { mode: 0o644 })
  fs.renameSync(next, file)
}

function writePublic(root: string, authorities: readonly Authority[], systemBundle: string | null): string {
  const publicDir = path.join(root, 'public')
  fs.mkdirSync(publicDir, { recursive: true, mode: 0o755 })
  const certs = authorities.map((ca) => fs.readFileSync(path.join(ca.dir, 'ca.pem'), 'utf8').trimEnd()).join('\n')
  const system = systemBundle === null ? '' : fs.readFileSync(systemBundle, 'utf8')
  replaceFile(path.join(publicDir, 'ca.pem'), `${certs}\n`)
  replaceFile(path.join(publicDir, 'bundle.pem'), `${system.trimEnd()}\n${certs}\n`)
  return publicDir
}

/**
 * Loads the CAs the egress proxy signs intercepted hosts with, creating the first one on use.
 * Each CA is name-constrained to the hosts it was made for; a host none covers gets a new CA of
 * its own, so earlier ones never change. Certificates are issued on demand; keys stay in `root`.
 */
export async function loadSandboxCa(root: string): Promise<SandboxCa> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  fs.chmodSync(root, 0o700)
  if (!fs.existsSync(path.join(root, 'ca.key')) || !fs.existsSync(path.join(root, 'ca.pem'))) {
    await createCa(root, PERMITTED_DOMAINS)
  }
  const leafKey = path.join(root, 'leaf.key')
  if (!fs.existsSync(leafKey)) {
    await openssl(['genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', leafKey])
    fs.chmodSync(leafKey, 0o600)
  }
  const key = fs.readFileSync(leafKey)
  const authorities: Authority[] = [{ dir: root, permitted: PERMITTED_DOMAINS }, ...readExtras(root)]
  const systemBundle = SYSTEM_BUNDLES.find((file) => fs.existsSync(file)) ?? null
  const publicDir = writePublic(root, authorities, systemBundle)
  const contexts = new Map<string, Promise<tls.SecureContext>>()
  let adding: Promise<boolean> = Promise.resolve(false)

  const issue = async (host: string): Promise<tls.SecureContext> => {
    const ca = authorities.find((authority) => permits(authority, host))
    if (ca === undefined) {
      throw new Error(`No sandbox CA may sign ${host}`)
    }
    return tls.createSecureContext({ key, cert: await leafCertificate(leafKey, ca, host) })
  }

  const addCa = async (hosts: readonly string[]): Promise<boolean> => {
    const missing = [...new Set(hosts.map((host) => host.toLowerCase()))]
      .filter((host) => VALID_HOST.test(host) && !authorities.some((ca) => permits(ca, host)))
      .toSorted((a, b) => a.localeCompare(b, 'en'))
    if (missing.length === 0) {
      return false
    }
    const id = createHash('sha256').update(missing.join('\n')).digest('hex').slice(0, 12)
    const dir = path.join(root, 'extra', `${String(Date.now())}-${id}`)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    await createCa(dir, missing)
    fs.writeFileSync(path.join(dir, 'hosts.json'), `${JSON.stringify(missing)}\n`)
    authorities.push({ dir, permitted: missing })
    writePublic(root, authorities, systemBundle)
    return true
  }

  return {
    publicDir,
    systemBundle,
    contextFor: async (host) => {
      let context = contexts.get(host)
      if (context === undefined) {
        context = issue(host)
        contexts.set(host, context)
        context.catch(() => contexts.delete(host))
      }
      return context
    },
    cover: async (hosts) => {
      adding = adding.catch(() => false).then(async () => addCa(hosts))
      return adding
    },
    covers: (host) => authorities.some((ca) => permits(ca, host)),
  }
}
