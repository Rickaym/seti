import { EventEmitter } from 'node:events'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)

/** What the demo answers a program with instead of running it; null refuses the program. */
export type CommandFake = (program: string, args: readonly string[]) => string | null

/** Thrown for every process, terminal, worker and connection the demo refuses. */
export class DemoRefusal extends Error {
  /** Callers treat a refused program like one that is not installed. */
  readonly code = 'ENOENT'
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void

const refusal = (what: string) => new DemoRefusal(`The demo never ${what}`)

const programName = (file: unknown) => path.basename(String(file))

/** A child that never started: it reports the refusal as a missing program would, then closes. */
function refusedChild(file: unknown): EventEmitter {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdin: new Writable({
      write: (_chunk, _encoding, done) => {
        done()
      },
    }),
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    stdio: [],
    kill: () => false,
    ref: () => undefined,
    unref: () => undefined,
  })
  process.nextTick(() => {
    if (child.listenerCount('error') > 0) {
      child.emit('error', refusal(`runs ${programName(file)}`))
    }
    child.emit('exit', -2, null)
    child.emit('close', -2, null)
  })
  return child
}

const argList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : [])

/** execFile and its promisified form, answered by the fakes or refused; nothing starts. */
function fakeExecFile(fake: CommandFake) {
  const answer = (file: unknown, args: unknown) => {
    const output = fake(programName(file), argList(args))
    if (output === null) {
      throw refusal(`runs ${programName(file)}`)
    }
    return output
  }
  const execFile = (file: unknown, ...rest: unknown[]) => {
    const callback = rest.findLast((arg): arg is Callback => typeof arg === 'function')
    process.nextTick(() => {
      try {
        callback?.(null, answer(file, rest[0]), '')
      } catch (e) {
        callback?.(e as Error, '', '')
      }
    })
    return refusedChild(file)
  }
  const promised = async (file: unknown, args?: unknown) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      try {
        resolve({ stdout: answer(file, args), stderr: '' })
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  return Object.assign(execFile, { [promisify.custom]: promised })
}

function fakeExecFileSync(fake: CommandFake) {
  return (file: unknown, args?: unknown, options?: { encoding?: string }) => {
    const output = fake(programName(file), argList(args))
    if (output === null) {
      throw refusal(`runs ${programName(file)}`)
    }
    return options?.encoding === undefined || options.encoding === 'buffer' ? Buffer.from(output) : output
  }
}

const refusedSync = (file: unknown) => ({
  pid: 0,
  output: [],
  stdout: '',
  stderr: '',
  status: null,
  signal: null,
  error: refusal(`runs ${programName(file)}`),
})

const throws = (what: string) => () => {
  throw refusal(what)
}

/** Replaces every way to start a process, so nothing the server does can run a program. */
function sealProcesses(fake: CommandFake): void {
  const childProcess = require('node:child_process') as Record<string, unknown> & {
    ChildProcess: { prototype: Record<string, unknown> }
  }
  const replacements: Record<string, unknown> = {
    spawn: refusedChild,
    fork: refusedChild,
    exec: (_command: unknown, ...rest: unknown[]) => {
      const callback = rest.findLast((arg): arg is Callback => typeof arg === 'function')
      process.nextTick(() => callback?.(refusal('runs a shell'), '', ''))
      return refusedChild('sh')
    },
    execFile: fakeExecFile(fake),
    execFileSync: fakeExecFileSync(fake),
    execSync: throws('runs a shell'),
    spawnSync: refusedSync,
  }
  for (const [name, value] of Object.entries(replacements)) {
    childProcess[name] = value
  }
  childProcess.ChildProcess.prototype.spawn = throws('starts a process')
  const pty = require('node-pty') as Record<string, unknown>
  for (const name of ['spawn', 'fork', 'createTerminal', 'open']) {
    pty[name] = throws('opens a terminal')
  }
  const workers = require('node:worker_threads') as Record<string, unknown>
  workers.Worker = function RefusedWorker() {
    throw refusal('starts a worker')
  }
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/** Loopback hosts reach the demo's own database and fakes; every other host is refused. */
export function loopbackHost(host: string | undefined): boolean {
  const name = (host ?? 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '')
  return name === 'localhost' || name === '::1' || LOOPBACK_V4.test(name)
}

interface ConnectTarget {
  path?: unknown
  host?: unknown
}

/** The target of a Socket#connect call, in each of the shapes Node passes it. */
export function connectTarget(args: readonly unknown[]): ConnectTarget {
  const [first, second] = args
  const options: unknown = Array.isArray(first) ? first[0] : first
  if (typeof options === 'object' && options !== null) {
    return options
  }
  if (typeof options === 'string' && !/^\d+$/.test(options)) {
    return { path: options }
  }
  return { host: second }
}

const allowedTarget = (target: ConnectTarget) =>
  typeof target.path === 'string' ||
  (target.host === undefined || typeof target.host === 'string' ? loopbackHost(target.host) : false)

/** Lets sockets reach only unix sockets and loopback, so nothing leaves the machine. */
function sealNetwork(): void {
  const net = require('node:net') as { Socket: { prototype: Record<string, unknown> } }
  const connect = net.Socket.prototype.connect as (...args: unknown[]) => unknown
  net.Socket.prototype.connect = function demoConnect(this: unknown, ...args: unknown[]) {
    if (!allowedTarget(connectTarget(args))) {
      throw refusal('reaches the network')
    }
    return connect.apply(this, args)
  }
  const dgram = require('node:dgram') as Record<string, unknown>
  dgram.createSocket = throws('reaches the network')
}

/** Seals the process before any server module loads; ES module imports see the sealed functions. */
export function sealDemoProcess(fake: CommandFake): void {
  sealProcesses(fake)
  sealNetwork()
  syncBuiltinESMExports()
}
