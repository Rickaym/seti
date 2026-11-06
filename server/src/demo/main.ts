/**
 * The public demo of Seti: scripted agents, a fake GitHub and a fake EA over a fresh database.
 * It seals the process before any server module loads, so nothing it serves can run a program,
 * open a terminal or reach the network beyond loopback, and it starts only with SETI_DEMO=1.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fakeGh } from './github.js'
import { sealDemoProcess } from './seal.js'

/** The only variables the demo keeps; tokens and keys of the shell it starts from never reach it. */
const KEPT_ENV = new Set([
  'PATH',
  'LANG',
  'LC_ALL',
  'TZ',
  'SETI_DEMO',
  'SETI_DEMO_RESET_HOURS',
  'SETI_HOME',
  'SETI_DATABASE_URL',
  'SETI_HOST',
  'SETI_PORT',
  'SETI_PUBLIC_URL',
])

function stop(message: string): never {
  process.stderr.write(`seti demo: ${message}\n`)
  process.exit(1)
}

/** The demo's data folder, which must start empty so it never runs over a real Seti's data. */
function dataRoot(): string {
  const root = process.env.SETI_HOME ?? ''
  if (root === '' || !path.isAbsolute(root)) {
    stop('set SETI_HOME to an empty folder for the demo data')
  }
  if (fs.existsSync(root) && fs.readdirSync(root).length > 0) {
    stop(`SETI_HOME must be an empty folder: ${root}`)
  }
  return root
}

function demoEnvironment(root: string): void {
  for (const name of Object.keys(process.env)) {
    if (!KEPT_ENV.has(name)) {
      Reflect.deleteProperty(process.env, name)
    }
  }
  const dirs = {
    SETI_HOME: path.join(root, 'seti'),
    HOME: path.join(root, 'home'),
    SETI_CLAUDE_HOME: path.join(root, 'claude'),
    SETI_SCRATCH_ROOT: path.join(root, 'work'),
    SETI_SOURCE_DIR: path.join(root, 'source'),
    SETI_CREDENTIALS_DIR: path.join(root, 'credentials'),
  }
  for (const dir of Object.values(dirs)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  Object.assign(process.env, dirs, {
    NODE_ENV: 'production',
    SETI_REDIS_URL: 'off',
    SETI_WEATHER_URL: 'off',
    SETI_AUTH_IDLE_DAYS: '1',
    SETI_AUTH_MAX_DAYS: '1',
  })
}

/** Fresh keys and tokens for this run alone; they stay in the data folder and are never shown. */
function writeCredentials(dir: string): void {
  const values = {
    'secret-key': randomBytes(32).toString('base64'),
    'local-token-user': randomBytes(32).toString('base64url'),
    'local-token-ea': randomBytes(32).toString('base64url'),
  }
  for (const [name, value] of Object.entries(values)) {
    fs.writeFileSync(path.join(dir, name), `${value}\n`, { mode: 0o600 })
  }
}

if (process.env.SETI_DEMO !== '1') {
  stop('the demo starts only with SETI_DEMO=1; run it with pnpm demo or its container')
}
const root = dataRoot()
demoEnvironment(root)
writeCredentials(path.join(root, 'credentials'))
sealDemoProcess((program, args) => (program === 'gh' ? fakeGh(args) : null))
const { serveDemo } = await import('./serve.js')
await serveDemo(root)
