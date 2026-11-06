import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Port 1 never listens here, so the EA proxy always meets a bot that is down. */
const EA_URL = 'http://127.0.0.1:1'

/** Created once by the runner process; workers inherit it through the environment. */
function suiteRoot(): string {
  const inherited = process.env.SETI_E2E_ROOT
  if (inherited !== undefined && inherited !== '') {
    return inherited
  }
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-e2e-'))
  process.env.SETI_E2E_ROOT = created
  return created
}

export const SUITE_ROOT = suiteRoot()

/** A worker that replaces a failed one gets a new index, so it never meets the old files. */
const WORKER = process.env.TEST_WORKER_INDEX ?? 'runner'

const root = path.join(SUITE_ROOT, `worker-${WORKER}`)
const home = path.join(root, 'home')

export const paths = {
  root,
  home,
  setiHome: path.join(root, 'seti'),
  claudeHome: path.join(home, '.claude'),
  origin: path.join(root, 'origin.git'),
  checkout: path.join(root, 'checkout'),
  secondOrigin: path.join(root, 'second-origin.git'),
  secondCheckout: path.join(root, 'second-checkout'),
  /** The checkout Seti reads its changelog from, in place of its own. */
  source: path.join(root, 'seti-source'),
  /** Where the update check finds a newer Seti. */
  sourceOrigin: path.join(root, 'seti-source-origin.git'),
  userClaudeMd: path.join(home, '.claude', 'CLAUDE.md'),
  plugin: path.join(root, 'e2e-plugin'),
  credentials: path.join(root, 'credentials'),
}

/** Local API tokens of this run, the same in the runner and every worker. */
const localToken = (caller: string) => createHash('sha256').update(`${SUITE_ROOT}:${caller}`).digest('base64url')

export const LOCAL_TOKENS = { user: localToken('user'), ea: localToken('ea') } as const

/** What a local browser or script sends to reach the API as the user. */
export const USER_HEADERS = { authorization: `Bearer ${LOCAL_TOKENS.user}` }

/** What the EA voice bot sends: its own token, plus the label it adds to every call. */
export const EA_HEADERS = { authorization: `Bearer ${LOCAL_TOKENS.ea}`, 'x-seti-via': 'ea' }

/** The suite's database server: SETI_TEST_DATABASE_URL in CI, else the local socket. */
const DATABASE_SERVER = process.env.SETI_TEST_DATABASE_URL ?? 'postgresql:///postgres?host=/var/run/postgresql'

/** Every database of this run starts with it, so the teardown finds those workers left. */
export const DATABASE_PREFIX = `seti_e2e_${createHash('sha256').update(SUITE_ROOT).digest('hex').slice(0, 12)}_`

const databaseUrl = (name: string) => {
  const url = new URL(DATABASE_SERVER)
  url.pathname = `/${name}`
  return url.toString()
}

/** This worker's own database; its server creates it and Redis keys follow its name. */
export const DATABASE_URL = databaseUrl(`${DATABASE_PREFIX}w${WORKER}`)

export const ADMIN_DATABASE_URL = databaseUrl('postgres')

/** The demo drops and seeds its database on every start, and runs only on a seti_demo one. */
export const DEMO_DATABASE_PREFIX = `seti_demo_${DATABASE_PREFIX.slice('seti_e2e_'.length)}`

export const DEMO_DATABASE_URL = databaseUrl(`${DEMO_DATABASE_PREFIX}w${WORKER}`)

/** The local plugin folder each worker writes under paths.plugin. */
export const PLUGIN = { name: 'e2e-plugin', skill: 'hello-seti' } as const

const DROPPED_ENV = /^(ANTHROPIC_|AWS_|CLAUDE|GH_|GITHUB_TOKEN$|SETI_|CREDENTIALS_DIRECTORY$|NODE_ENV$)/

/** The server runs as a machine with no Claude login, GitHub access or AWS identity, like CI. */
export function serverEnv(): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !DROPPED_ENV.test(key)))
  return {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SETI_HOME: paths.setiHome,
    SETI_SOURCE_DIR: paths.source,
    SETI_CLAUDE_HOME: paths.claudeHome,
    SETI_DATABASE_URL: DATABASE_URL,
    ...(process.env.SETI_TEST_REDIS_URL === undefined ? {} : { SETI_REDIS_URL: process.env.SETI_TEST_REDIS_URL }),
    SETI_HOST: '127.0.0.1',
    SETI_PORT: '0',
    SETI_EA_URL: EA_URL,
    SETI_WEATHER_URL: 'off',
    SETI_POLLER_LOOPBACK: '1',
    SETI_TEST_MODS: '1',
    SETI_PLANNER_MODULE: path.join(import.meta.dirname, 'fake-planner.ts'),
    SETI_TERMINAL_SHELL: '/bin/bash',
    NODE_ENV: 'test',
    SETI_DEV_CREDENTIALS_DIR: paths.credentials,
    AWS_EC2_METADATA_DISABLED: 'true',
  }
}
