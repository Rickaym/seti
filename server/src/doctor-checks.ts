import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@redis/client'
import { binaryPath } from './binaries.js'
import { CLAUDE_BIN, CLAUDE_HOME, CREDENTIALS, DATABASE_URL, PORT, REDIS_URL, UI_DIST } from './config.js'
import {
  answers,
  atLeast,
  credentialChecks,
  findProgram,
  loopbackFor,
  portBusy,
  redact,
  runQuiet,
  within,
  type Check,
} from './doctor.js'
import { detectScopeHost } from './memory-scope.js'
import { connect, databaseOf, errorCode, withDatabase, type Pool } from './pg.js'
import { doctorProbes } from './store/doctor.js'
import { MIGRATIONS } from './store/schema.js'

const NODE_MIN = '24.0.0'
const PG_TESTED = 16
const DB_TIMEOUT_MS = 5000
const ROOT = path.resolve(import.meta.dirname, '../..')

const check = (section: string, state: Check['state'], label: string, fix?: string): Check =>
  fix === undefined ? { section, state, label } : { section, state, label, fix }

function pnpmWanted(): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { packageManager?: string }
  return manifest.packageManager?.replace(/^pnpm@/, '') ?? '10.0.0'
}

export async function runtimeChecks(): Promise<Check[]> {
  const s = 'Runtime'
  const platform = process.platform === 'linux' ? 'Linux' : `${process.platform}, not supported for the sandbox`
  const checks = [check(s, process.platform === 'linux' ? 'ok' : 'warn', `platform ${platform} (${process.arch})`)]
  const node = process.versions.node
  checks.push(
    atLeast(node, NODE_MIN)
      ? check(s, 'ok', `node ${node}`)
      : check(s, 'fail', `node ${node} is older than 24`, 'nvm install 24 && nvm use 24'),
  )
  const wanted = pnpmWanted()
  const pnpm = await runQuiet('pnpm', ['--version'])
  if (pnpm.code !== 0) {
    checks.push(check(s, 'fail', 'pnpm not found', 'corepack enable pnpm'))
  } else {
    const ok = atLeast(pnpm.stdout, wanted)
    checks.push(check(s, ok ? 'ok' : 'warn', `pnpm ${pnpm.stdout}`, ok ? undefined : 'corepack enable pnpm'))
  }
  checks.push(
    binaryPath('git') === null ? check(s, 'fail', 'git not found', 'sudo apt-get install git') : check(s, 'ok', 'git'),
  )
  const uv = findProgram('uv')
  checks.push(
    uv === null
      ? check(
          s,
          'warn',
          'uv not found; the EA and pnpm check need it',
          'curl -LsSf https://astral.sh/uv/install.sh | sh',
        )
      : check(s, 'ok', `uv at ${uv}`),
  )
  const built = fs.existsSync(path.join(UI_DIST, 'index.html'))
  checks.push(built ? check(s, 'ok', 'UI built') : check(s, 'fail', 'UI not built', `cd ${ROOT} && pnpm build`))
  return checks
}

export const credentialsChecks = () => credentialChecks(CREDENTIALS.dir, CREDENTIALS.dev)

const ROLE_FIX = 'sudo -u postgres createuser --createdb "$USER"'

/** Why the database could not be opened, and what fixes it. */
async function databaseProblem(e: unknown, url: string): Promise<Check> {
  const s = 'Database'
  const code = errorCode(e)
  const message = e instanceof Error ? e.message : String(e)
  if (code === '3D000') {
    const admin = connect(withDatabase(url, 'postgres'), 1)
    try {
      const create = await within(DB_TIMEOUT_MS, doctorProbes.canCreateDatabases(admin))
      return create
        ? check(s, 'ok', `database ${databaseOf(url)} does not exist yet; Seti creates it on first start`)
        : check(s, 'fail', `database ${databaseOf(url)} is missing and this role may not create it`, ROLE_FIX)
    } catch {
      return check(s, 'fail', `database ${databaseOf(url)} is missing: ${message}`, ROLE_FIX)
    } finally {
      await admin.end({ timeout: 1 })
    }
  }
  if (code === '28000' || code === '28P01') {
    return check(s, 'fail', `PostgreSQL refused this user: ${message}`, `${ROLE_FIX}\nor fix SETI_DATABASE_URL`)
  }
  const down = code === 'ECONNREFUSED' || code === 'ENOENT'
  const fix = down ? 'sudo apt-get install postgresql && sudo systemctl start postgresql' : 'check SETI_DATABASE_URL'
  return check(s, 'fail', `cannot reach PostgreSQL at ${redact(url)}: ${message}`, fix)
}

async function schemaChecks(pool: Pool, major: number): Promise<Check[]> {
  const s = 'Database'
  const checks: Check[] = []
  const applied = await within(DB_TIMEOUT_MS, doctorProbes.appliedMigrations(pool))
  const known = MIGRATIONS.map((migration) => migration.version)
  if (applied === null) {
    checks.push(check(s, 'info', 'not migrated yet; Seti applies every migration on first start'))
  } else {
    const pending = known.filter((version) => !applied.includes(version)).length
    const unknown = applied.filter((version) => !known.includes(version)).length
    checks.push(
      pending === 0
        ? check(s, 'ok', `migrated (${String(applied.length)} migrations)`)
        : check(s, 'info', `${String(pending)} migrations apply on the next start`),
    )
    if (unknown > 0) {
      const label = `the database has ${String(unknown)} migrations this checkout does not know (a newer Seti ran it)`
      checks.push(check(s, 'warn', label, 'scripts/upgrade.sh, or restore the dump taken before the rollback'))
    }
  }
  const vector = await within(DB_TIMEOUT_MS, doctorProbes.vector(pool))
  const vectorFix = `sudo -u postgres psql -d ${databaseOf(DATABASE_URL)} -c 'CREATE EXTENSION IF NOT EXISTS vector'`
  if (vector === 'installed') {
    checks.push(check(s, 'ok', 'pgvector installed; the EA searches by embeddings'))
  } else {
    const label = `pgvector ${vector === 'available' ? 'available but not created' : 'not installed'} (optional)`
    checks.push(
      check(
        s,
        'info',
        label,
        vector === 'available' ? vectorFix : `sudo apt-get install postgresql-${String(major)}-pgvector`,
      ),
    )
  }
  return checks
}

/** The database checks, and whether a long-lived Claude token is stored, for the Claude checks. */
export async function databaseChecks(): Promise<{ checks: Check[]; claudeToken: boolean }> {
  const s = 'Database'
  const pool = connect(DATABASE_URL, 1)
  try {
    const major = await within(DB_TIMEOUT_MS, doctorProbes.serverVersion(pool))
    const version =
      major >= PG_TESTED
        ? check(s, 'ok', `PostgreSQL ${String(major)} at ${redact(DATABASE_URL)}`)
        : check(s, 'warn', `PostgreSQL ${String(major)} is older than the tested ${String(PG_TESTED)}`)
    const checks = [version, ...(await schemaChecks(pool, major))]
    const claudeToken = await within(DB_TIMEOUT_MS, doctorProbes.hasSecret(pool, 'claude_oauth_token'))
    return { checks, claudeToken }
  } catch (e) {
    return { checks: [await databaseProblem(e, DATABASE_URL)], claudeToken: false }
  } finally {
    await pool.end({ timeout: 1 })
  }
}

export async function redisChecks(): Promise<Check[]> {
  const s = 'Cache'
  if (REDIS_URL === 'off') {
    return [check(s, 'info', 'Redis off (SETI_REDIS_URL=off); Seti runs without a cache')]
  }
  const socket = { connectTimeout: 2000, reconnectStrategy: false as const }
  const client = REDIS_URL.startsWith('/')
    ? createClient({ socket: { ...socket, path: REDIS_URL } })
    : createClient({ url: REDIS_URL, socket })
  client.on('error', () => undefined)
  try {
    await within(3000, client.connect())
    await within(3000, client.ping())
    return [check(s, 'ok', `Redis at ${redact(REDIS_URL)}`)]
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const fix = 'set SETI_REDIS_URL=off in seti.env, or start Redis (docs/setup.md, Redis)'
    return [check(s, 'warn', `Redis at ${redact(REDIS_URL)} does not answer: ${message}`, fix)]
  } finally {
    client.destroy()
  }
}

const SANDBOX_TOOLS: Record<string, string> = {
  bwrap: 'bubblewrap',
  socat: 'socat',
  setpriv: 'util-linux',
  openssl: 'openssl',
  'ssh-agent': 'openssh-client',
  'ssh-keygen': 'openssh-client',
}

const APPARMOR_USERNS = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'

export async function sandboxChecks(): Promise<Check[]> {
  const s = 'Sandbox'
  if (process.platform !== 'linux') {
    const label = 'the agent sandbox needs Linux; turn it off in Settings, Sandbox, and agents run as you'
    return [check(s, 'warn', label)]
  }
  const missing = Object.keys(SANDBOX_TOOLS).filter((tool) => binaryPath(tool) === null)
  if (missing.length > 0) {
    const packages = [...new Set(missing.map((tool) => SANDBOX_TOOLS[tool] ?? tool))].join(' ')
    return [check(s, 'fail', `missing ${missing.join(', ')}`, `sudo apt-get install ${packages}`)]
  }
  const checks = [check(s, 'ok', 'bwrap, socat, setpriv, openssl and ssh tools installed')]
  const args = ['--unshare-user', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev', '/dev']
  const probe = await runQuiet('bwrap', [...args, '--proc', '/proc', 'true'])
  if (probe.code === 0) {
    checks.push(check(s, 'ok', 'bwrap can create user namespaces'))
  } else {
    const restricted = (await fs.promises.readFile(APPARMOR_USERNS, 'utf8').catch(() => '0')).trim() === '1'
    const fix = restricted
      ? 'AppArmor restricts user namespaces: re-run scripts/install.sh, or add the bwrap profile\n' +
        'from docs/setup.md, Sandbox'
      : 'enable unprivileged user namespaces (sysctl user.max_user_namespaces)'
    const label =
      'bwrap cannot create user namespaces, so no agent can start sandboxed, and reminders and mod logic ' +
      'run without network isolation'
    checks.push(check(s, 'fail', label, fix))
  }
  const scopes = await detectScopeHost()
  if (scopes === null) {
    checks.push(
      check(s, 'warn', 'no systemd user manager: agents run without a memory cap', 'scripts/install.sh --service'),
    )
  } else if (scopes.cpu) {
    checks.push(check(s, 'ok', 'memory and CPU caps through systemd user scopes'))
  } else {
    const fix = 'delegate it to user@.service: Delegate=cpu cpuset io memory pids in a drop-in'
    checks.push(check(s, 'warn', 'memory caps only: the user manager has no cpu controller', fix))
  }
  return checks
}

/** The host Claude Code login holds an OAuth access token; macOS keeps it in the keychain instead. */
function hostLogin(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(CLAUDE_HOME, '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: unknown }
    }
    const token = parsed.claudeAiOauth?.accessToken
    return typeof token === 'string' && token !== ''
  } catch {
    return false
  }
}

export async function claudeChecks(claudeToken: boolean): Promise<Check[]> {
  const s = 'Claude Code'
  const version = await runQuiet(CLAUDE_BIN, ['--version'])
  const checks = [
    version.code === 0
      ? check(s, 'ok', `${version.stdout} at ${CLAUDE_BIN}`)
      : check(s, 'fail', `cannot run ${CLAUDE_BIN}`, 'curl -fsSL https://claude.ai/install.sh | bash'),
  ]
  if (claudeToken) {
    checks.push(check(s, 'ok', 'long-lived token stored in Settings, Credentials'))
  } else if (hostLogin()) {
    checks.push(check(s, 'ok', `signed in (${CLAUDE_HOME})`))
  } else {
    const state = process.platform === 'darwin' ? 'info' : 'warn'
    const fix = 'Next: run `claude` and /login, or `claude setup-token` and paste the token in Settings, Credentials'
    checks.push(check(s, state, 'no Claude login found', fix))
  }
  return checks
}

export async function githubChecks(): Promise<Check[]> {
  const s = 'GitHub'
  if (binaryPath('gh') === null) {
    return [check(s, 'warn', 'gh not found; Seti watches PRs with it', 'sudo apt-get install gh && gh auth login')]
  }
  const status = await runQuiet('gh', ['auth', 'status', '--hostname', 'github.com'])
  return [
    status.code === 0
      ? check(s, 'ok', 'gh signed in to github.com')
      : check(s, 'warn', 'gh is not signed in; PR watching stays off', 'gh auth login'),
  ]
}

/** Whether Seti answers on its port, and otherwise whether something else holds it. */
export async function portChecks(host: string, eaUrl: string): Promise<Check[]> {
  const s = 'Network'
  const base = `http://${loopbackFor(host)}:${String(PORT)}`
  const checks: Check[] = []
  if ((await answers(`${base}/api/ping`)) === 204) {
    checks.push(check(s, 'ok', `Seti answers on ${base}`))
  } else if (await portBusy(host, PORT)) {
    checks.push(check(s, 'fail', `port ${String(PORT)} is taken by another program`, 'set SETI_PORT in seti.env'))
  } else {
    checks.push(check(s, 'info', `port ${String(PORT)} is free; Seti is not running`))
  }
  const ea = await answers(`${eaUrl}/health`)
  checks.push(
    ea === null
      ? check(s, 'info', `the EA does not answer on ${eaUrl} (optional)`)
      : check(s, 'ok', `the EA answers on ${eaUrl}`),
  )
  return checks
}

export async function serviceChecks(): Promise<Check[]> {
  const s = 'Services'
  if (binaryPath('systemctl') === null) {
    return [check(s, 'info', 'no systemd: start Seti with scripts/start.sh')]
  }
  const enabled = await runQuiet('systemctl', ['--user', 'is-enabled', 'seti.service'])
  if (enabled.code !== 0) {
    return [check(s, 'info', 'seti.service is not installed', 'scripts/install.sh --service')]
  }
  const active = await runQuiet('systemctl', ['--user', 'is-active', 'seti.service'])
  const checks = [
    active.stdout === 'active'
      ? check(s, 'ok', 'seti.service is running')
      : check(s, 'fail', `seti.service is ${active.stdout}`, 'journalctl --user -u seti.service -n 50'),
  ]
  const linger = await runQuiet('loginctl', ['show-user', os.userInfo().username, '--property=Linger', '--value'])
  if (linger.stdout !== 'yes') {
    const fix = `sudo loginctl enable-linger ${os.userInfo().username}`
    checks.push(check(s, 'warn', 'lingering is off: services stop when you log out', fix))
  }
  return checks
}
