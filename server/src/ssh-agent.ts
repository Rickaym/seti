import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { findBinary } from './binaries.js'
import { addToAgent, clearAgent } from './ssh-keys.js'

export const SSH_AGENT_SOCKET = 'agent.sock'

const START_TIMEOUT_MS = 5000

/** The private keys an agent holds, read fresh on every load. */
export type KeyLoader = () => Promise<string[]>

interface RunningAgent {
  child: ChildProcess
  socket: string
  keys: KeyLoader
}

/** Each agent's last load, so loads run one after another. */
const loads = new WeakMap<RunningAgent, Promise<void>>()

/** One ssh-agent per sandboxed task, and short-lived ones for scans, each with only its own keys. */
const agents = new Map<string, Promise<RunningAgent>>()

async function waitForSocket(socket: string, child: ChildProcess): Promise<void> {
  const started = Date.now()
  while (!fs.existsSync(socket)) {
    if (child.exitCode !== null || Date.now() - started > START_TIMEOUT_MS) {
      throw new Error('ssh-agent did not start')
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function load(agent: RunningAgent): Promise<void> {
  await clearAgent(agent.socket)
  for (const key of await agent.keys()) {
    await addToAgent(agent.socket, key).catch((e: unknown) => {
      process.stderr.write(`ssh-agent: a key could not be loaded: ${e instanceof Error ? e.message : String(e)}\n`)
    })
  }
}

/** Starts an ssh-agent in `dir`, tied to the server so it never outlives it. */
async function start(id: string, dir: string, keys: KeyLoader): Promise<RunningAgent> {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.chmodSync(dir, 0o700)
  const socket = path.join(dir, SSH_AGENT_SOCKET)
  fs.rmSync(socket, { force: true })
  const child = spawn(findBinary('setpriv'), ['--pdeathsig', 'TERM', findBinary('ssh-agent'), '-D', '-a', socket], {
    stdio: 'ignore',
  })
  const agent: RunningAgent = { child, socket, keys }
  const ready = waitForSocket(socket, child).then(() => agent)
  agents.set(id, ready)
  child.on('exit', () => {
    if (agents.get(id) === ready) {
      agents.delete(id)
    }
  })
  return ready.catch((e: unknown) => {
    agents.delete(id)
    child.kill('SIGTERM')
    throw e
  })
}

async function reload(agent: RunningAgent): Promise<void> {
  const next = (loads.get(agent) ?? Promise.resolve()).catch(() => undefined).then(async () => load(agent))
  loads.set(agent, next)
  await next
}

/** The socket of agent `id` in `dir`, started on first use and loaded with exactly `keys` now. */
export async function sshAgentSocket(id: string, dir: string, keys: KeyLoader): Promise<string> {
  const existing = agents.get(id)
  const agent = await (existing ?? start(id, dir, keys))
  agent.keys = keys
  await reload(agent)
  return agent.socket
}

/** Loads every running agent's keys again, as after a key, login, host or access change. */
export async function reloadSshAgents(): Promise<void> {
  const running = await Promise.all([...agents.values()].map(async (agent) => agent.catch(() => null)))
  await Promise.all(running.map(async (agent) => (agent === null ? undefined : reload(agent))))
}

export async function stopSshAgent(id: string): Promise<void> {
  const current = agents.get(id)
  agents.delete(id)
  const agent = await current?.catch(() => null)
  agent?.child.kill('SIGTERM')
}

export async function stopSshAgents(): Promise<void> {
  await Promise.all([...agents.keys()].map(stopSshAgent))
}
