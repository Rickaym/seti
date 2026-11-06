import { execFileSync, spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import { SOURCE_HISTORY, UPSTREAM_HISTORY } from './changelog.js'
import { dropDatabases } from './db.js'
import { DEMO_DATABASE_URL, LOCAL_TOKENS, paths, PLUGIN, serverEnv } from './env.js'
import { seedSessions } from './sessions.js'

const SERVER_DIR = path.join(import.meta.dirname, '../../../server')
const START_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000
const LISTENING = /seti (?:demo )?listening on (http:\/\/\S+)/

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Seti E2E',
  GIT_AUTHOR_EMAIL: 'e2e@seti.invalid',
  GIT_COMMITTER_NAME: 'Seti E2E',
  GIT_COMMITTER_EMAIL: 'e2e@seti.invalid',
}

function git(cwd: string, ...args: string[]): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the git on the runner PATH
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' })
}

function seedRepo(checkout: string, origin: string): void {
  fs.mkdirSync(checkout, { recursive: true })
  git(paths.root, 'init', '--bare', '--initial-branch=main', origin)
  git(checkout, 'init', '--initial-branch=main')
  fs.writeFileSync(path.join(checkout, 'README.md'), '# Scratch repo for the Seti e2e suite\n')
  git(checkout, 'add', 'README.md')
  git(checkout, 'commit', '--message', 'chore: seed scratch repo')
  git(checkout, 'remote', 'add', 'origin', origin)
  git(checkout, 'push', '--set-upstream', 'origin', 'main')
}

function commitHistory(dir: string, history: readonly { date: string; message: string }[]): void {
  for (const change of history) {
    fs.appendFileSync(path.join(dir, 'CHANGES'), `${change.message}\n`)
    git(dir, 'add', 'CHANGES')
    const env = { ...GIT_ENV, GIT_AUTHOR_DATE: change.date, GIT_COMMITTER_DATE: change.date }
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- uses the git on the runner PATH
    execFileSync('git', ['commit', '--message', change.message], { cwd: dir, env, stdio: 'pipe' })
  }
}

/** The checkout Seti reads its changelog from, one update behind its origin's main. */
function seedSource(dir: string, origin: string): void {
  if (fs.existsSync(dir)) {
    return
  }
  fs.mkdirSync(dir, { recursive: true })
  git(dir, 'init', '--initial-branch=main')
  commitHistory(dir, SOURCE_HISTORY)
  git(paths.root, 'init', '--bare', '--initial-branch=main', origin)
  git(dir, 'remote', 'add', 'origin', origin)
  commitHistory(dir, UPSTREAM_HISTORY)
  git(dir, 'push', 'origin', 'main')
  git(dir, 'reset', '--hard', `HEAD~${String(UPSTREAM_HISTORY.length)}`)
}

function seedPlugin(): void {
  const skillDir = path.join(paths.plugin, 'skills', PLUGIN.skill)
  fs.mkdirSync(path.join(paths.plugin, '.claude-plugin'), { recursive: true })
  fs.mkdirSync(skillDir, { recursive: true })
  const manifest = { name: PLUGIN.name, version: '0.1.0', description: 'Fixture plugin for the Seti e2e suite' }
  fs.writeFileSync(path.join(paths.plugin, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  const skill = `---\nname: ${PLUGIN.skill}\ndescription: Greets from the e2e fixture plugin\n---\n\nSay hello.\n`
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skill)
}

/** The server makes its own store key; the tokens come from here so the tests know them. */
function seedCredentials(): void {
  fs.mkdirSync(paths.credentials, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(paths.credentials, 'local-token-user'), `${LOCAL_TOKENS.user}\n`, { mode: 0o600 })
  fs.writeFileSync(path.join(paths.credentials, 'local-token-ea'), `${LOCAL_TOKENS.ea}\n`, { mode: 0o600 })
}

type ServerProcess = ChildProcessByStdio<null, Readable, null>

/** Resolves with the origin the server prints once it listens; rejects if it stops first. */
async function listeningOrigin(child: ServerProcess): Promise<string> {
  let output = ''
  return new Promise((resolve, reject) => {
    const fail = (why: string) => {
      clearTimeout(timer)
      reject(new Error(`Seti ${why}:\n${output}`))
    }
    const timer = setTimeout(() => {
      fail(`did not start within ${String(START_TIMEOUT_MS)} ms`)
    }, START_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const origin = LISTENING.exec(output)?.[1]
      if (origin !== undefined) {
        clearTimeout(timer)
        child.stdout.removeAllListeners('data').resume()
        resolve(origin)
      }
    })
    child.once('error', (e) => {
      fail(`could not start: ${e.message}`)
    })
    child.once('exit', (code) => {
      fail(`exited with ${String(code)} before listening`)
    })
  })
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null

/** Ends the server's process group, which also holds the Claude Code probes it started. */
async function stop(child: ChildProcess, pid: number): Promise<void> {
  if (!running(child)) {
    return
  }
  const exited = once(child, 'exit')
  process.kill(-pid, 'SIGTERM')
  const timer = setTimeout(() => {
    process.kill(-pid, 'SIGKILL')
  }, STOP_TIMEOUT_MS)
  await exited
  clearTimeout(timer)
}

export interface WorkerServer {
  baseURL: string
  close: () => Promise<void>
}

/** Starts Node in the server folder and resolves once it listens; `drop` names its database. */
async function launch(args: string[], env: NodeJS.ProcessEnv, drop: 'worker' | 'demo'): Promise<WorkerServer> {
  const child = spawn(process.execPath, args, {
    cwd: SERVER_DIR,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const started = listeningOrigin(child)
  const { pid } = child
  if (pid === undefined) {
    await started
    throw new Error('Seti started without a process id')
  }
  /** A worker that exits without its teardown still takes its server along. */
  const orphaned = () => {
    if (running(child)) {
      process.kill(-pid, 'SIGKILL')
    }
  }
  process.once('exit', orphaned)
  const close = async () => {
    process.off('exit', orphaned)
    await stop(child, pid)
    await dropDatabases(drop)
    fs.rmSync(paths.root, { recursive: true, force: true })
  }
  try {
    return { baseURL: await started, close }
  } catch (e) {
    await close()
    throw e
  }
}

/** Seeds this worker's scratch files and starts its own Seti on a port the OS picks. */
export async function startWorkerServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<WorkerServer> {
  fs.mkdirSync(paths.home, { recursive: true })
  seedRepo(paths.checkout, paths.origin)
  seedRepo(paths.secondCheckout, paths.secondOrigin)
  seedSource(paths.source, paths.sourceOrigin)
  seedSessions()
  seedPlugin()
  seedCredentials()
  return launch(['--import', 'tsx', 'src/index.ts'], { ...serverEnv(), ...extraEnv }, 'worker')
}

/** Builds the demo's bundle and starts it with nothing but what its container gives it. */
export async function startDemoServer(): Promise<WorkerServer> {
  execFileSync(process.execPath, ['scripts/build-demo.mjs'], { cwd: path.join(SERVER_DIR, '..'), stdio: 'pipe' })
  const env = {
    PATH: process.env.PATH ?? '',
    TZ: 'Europe/Berlin',
    SETI_DEMO: '1',
    SETI_HOME: path.join(paths.root, 'demo'),
    SETI_HOST: '127.0.0.1',
    SETI_PORT: '0',
    SETI_DATABASE_URL: DEMO_DATABASE_URL,
  }
  return launch(['dist/main.js'], env, 'demo')
}
