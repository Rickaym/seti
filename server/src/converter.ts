import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binaryPath } from './binaries.js'

const MB = 1024 * 1024

/** What one run may use; the kernel enforces memory, CPU time and file size. */
export interface ConverterLimits {
  timeoutMs: number
  cpuSeconds: number
  /** Address space of each process in the run. */
  memoryBytes: number
  /** The largest file any process may write. */
  fileBytes: number
  /** Everything the run leaves in /out and prints, together. */
  outputBytes: number
  /** The size of the run's private /tmp; unsized when absent. */
  tmpBytes?: number
}

export interface ConverterJob {
  /** A program on the converter path, run by name; one outside /usr is mounted read-only. */
  program: string
  args: readonly string[]
  /** Files placed read-only under /in, by name. */
  inputs: ReadonlyMap<string, Buffer>
  limits: ConverterLimits
  /** Configuration a program needs beyond the usual system files, mounted read-only. */
  system?: readonly string[]
}

export type ConverterResult = { ok: true; stdout: Buffer; files: Map<string, Buffer> } | { ok: false; error: string }

/** Programs run at most two at a time, at low priority, so previews never starve the host. */
const SLOTS = 2
const NICENESS = '15'
const WATCH_MS = 100
const STDERR_KEPT = 2048
const OPEN_FILES = '256'
const SANDBOX_BIN = '/opt/seti-bin'

/** Where converters come from: the service's PATH, then the usual system places. */
const searchPath = () =>
  [process.env.PATH ?? '', path.join(os.homedir(), '.local/bin'), '/usr/local/bin', '/usr/bin'].join(':')

/** The absolute path of a converter, or null when this host does not have it. */
export const converterPath = (name: string): string | null => binaryPath(name, searchPath())

const SYSTEM_FILES = ['/etc/fonts', '/etc/alternatives', '/etc/ld.so.cache', '/var/cache/fontconfig']

/** Paths outside /usr are mounted read-only at a fixed place inside the sandbox. */
const insidePath = (program: string) =>
  program.startsWith('/usr/') ? program : path.posix.join(SANDBOX_BIN, path.basename(program))

/**
 * bwrap arguments: every namespace unshared (network included), no capabilities, /usr and the
 * font and linker configuration read-only, an empty /tmp, the input copy read-only at /in and a
 * fresh /out. Nothing of the home directory or Seti's data is mounted.
 */
export function converterBwrapArgs(
  dirs: { input: string; output: string },
  program: string,
  extra: { system?: readonly string[] | undefined; tmpBytes?: number | undefined } = {},
): string[] {
  const own = program.startsWith('/usr/') ? [] : ['--ro-bind', program, insidePath(program)]
  const tmpSize = extra.tmpBytes === undefined ? [] : ['--size', String(extra.tmpBytes)]
  return [
    '--unshare-all',
    '--die-with-parent',
    '--new-session',
    '--cap-drop',
    'ALL',
    '--ro-bind',
    '/usr',
    '/usr',
    ...['bin', 'sbin', 'lib', 'lib64'].flatMap((dir) => ['--symlink', `usr/${dir}`, `/${dir}`]),
    ...[...SYSTEM_FILES, ...(extra.system ?? [])].flatMap((file) => ['--ro-bind-try', file, file]),
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    ...tmpSize,
    '--tmpfs',
    '/tmp',
    '--ro-bind',
    dirs.input,
    '/in',
    '--bind',
    dirs.output,
    '/out',
    ...own,
    '--clearenv',
    '--setenv',
    'PATH',
    '/usr/bin',
    '--setenv',
    'HOME',
    '/tmp',
    '--setenv',
    'LANG',
    'C.UTF-8',
    '--chdir',
    '/tmp',
  ]
}

/** prlimit arguments: memory, CPU seconds, file size, open files, and no core dumps. */
export const converterLimitArgs = (limits: ConverterLimits): string[] => [
  `--as=${String(limits.memoryBytes)}`,
  `--cpu=${String(limits.cpuSeconds)}`,
  `--fsize=${String(limits.fileBytes)}`,
  `--nofile=${OPEN_FILES}`,
  '--core=0',
]

interface Tools {
  bwrap: string
  prlimit: string
  nice: string
}

function tools(): Tools | null {
  const bwrap = binaryPath('bwrap', searchPath())
  const prlimit = binaryPath('prlimit', searchPath())
  const nice = binaryPath('nice', searchPath())
  return bwrap === null || prlimit === null || nice === null ? null : { bwrap, prlimit, nice }
}

let running = 0
const waiting: (() => void)[] = []

async function slot(): Promise<() => void> {
  if (running >= SLOTS) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running += 1
  return () => {
    running -= 1
    waiting.shift()?.()
  }
}

/** A private work folder: on the shared-memory tmpfs when the host has one, else the temp dir. */
function workDir(): string {
  const base = fs.existsSync('/dev/shm') ? '/dev/shm' : os.tmpdir()
  return fs.mkdtempSync(path.join(base, 'seti-convert-'))
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0
  for (const name of await fs.promises.readdir(dir)) {
    total += (await fs.promises.lstat(path.join(dir, name))).size
  }
  return total
}

async function collect(dir: string, limits: ConverterLimits): Promise<Map<string, Buffer> | string> {
  const files = new Map<string, Buffer>()
  let total = 0
  for (const name of (await fs.promises.readdir(dir)).sort((a, b) => a.localeCompare(b))) {
    const stat = await fs.promises.lstat(path.join(dir, name))
    if (!stat.isFile()) {
      continue
    }
    total += stat.size
    if (stat.size > limits.fileBytes || total > limits.outputBytes) {
      return `the converter wrote over ${String(Math.round(limits.outputBytes / MB))} MB`
    }
    files.set(name, await fs.promises.readFile(path.join(dir, name)))
  }
  return files
}

/** One line of what the program said on stderr, clipped and stripped of control characters. */
function lastWords(stderr: string): string {
  const line = stderr
    .split('\n')
    .map((entry) => entry.replace(/\p{Cc}/gu, ' ').trim())
    .filter((entry) => entry !== '')
    .at(-1)
  return line === undefined ? '' : `: ${line.slice(0, 200)}`
}

function failure(job: ConverterJob, code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  if (signal === 'SIGXCPU') {
    return `${job.program} ran out of CPU time`
  }
  if (signal === 'SIGXFSZ') {
    return `${job.program} wrote a file over ${String(Math.round(job.limits.fileBytes / MB))} MB`
  }
  const how = signal ?? `exit ${String(code)}`
  return `${job.program} failed (${how})${lastWords(stderr)}`
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  stopped: string | null
  stdout: Buffer
  stderr: string
}

/** Runs the sandboxed command, killing its whole group at the timeout or the output cap. */
async function execute(command: string[], output: string, job: ConverterJob): Promise<Exit> {
  const [file = '', ...args] = command
  const child = spawn(file, args, { env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  let stopped: string | null = null
  const kill = (why: string) => {
    stopped ??= why
    try {
      if (child.pid !== undefined) {
        process.kill(-child.pid, 'SIGKILL')
      }
    } catch {
      child.kill('SIGKILL')
    }
  }
  const { limits } = job
  const chunks: Buffer[] = []
  let printed = 0
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    printed += chunk.length
    if (printed > limits.outputBytes) {
      kill(`${job.program} printed over ${String(Math.round(limits.outputBytes / MB))} MB`)
      return
    }
    chunks.push(chunk)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT)
  })
  const timer = setTimeout(() => {
    kill(`${job.program} ran over its ${String(limits.timeoutMs / 1000)} s timeout`)
  }, limits.timeoutMs)
  let checking = false
  const watch = setInterval(() => {
    if (checking) {
      return
    }
    checking = true
    void folderBytes(output)
      .then((bytes) => {
        if (bytes + printed > limits.outputBytes) {
          kill(`${job.program} wrote over ${String(Math.round(limits.outputBytes / MB))} MB`)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        checking = false
      })
  }, WATCH_MS)
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.on('close', (exitCode, exitSignal) => {
      resolve([exitCode, exitSignal])
    })
    child.on('error', (error) => {
      stderr = error.message
      resolve([null, null])
    })
  })
  clearTimeout(timer)
  clearInterval(watch)
  return { code, signal, stopped, stdout: Buffer.concat(chunks), stderr }
}

async function runIn(work: string, job: ConverterJob, host: Tools, program: string): Promise<ConverterResult> {
  const input = path.join(work, 'in')
  const output = path.join(work, 'out')
  await fs.promises.mkdir(input)
  await fs.promises.mkdir(output)
  for (const [name, bytes] of job.inputs) {
    await fs.promises.writeFile(path.join(input, path.basename(name)), bytes)
  }
  const command = [
    host.prlimit,
    ...converterLimitArgs(job.limits),
    '--',
    host.nice,
    '-n',
    NICENESS,
    host.bwrap,
    ...converterBwrapArgs({ input, output }, program, { system: job.system, tmpBytes: job.limits.tmpBytes }),
    '--',
    insidePath(program),
    ...job.args,
  ]
  const exit = await execute(command, output, job)
  if (exit.stopped !== null) {
    return { ok: false, error: exit.stopped }
  }
  if (exit.code !== 0) {
    return { ok: false, error: failure(job, exit.code, exit.signal, exit.stderr) }
  }
  const files = await collect(output, job.limits)
  return typeof files === 'string' ? { ok: false, error: files } : { ok: true, stdout: exit.stdout, files }
}

/** Runs one converter in the sandbox; it never runs one outside it, and it never throws. */
export async function runConverter(job: ConverterJob): Promise<ConverterResult> {
  const host = tools()
  const program = converterPath(job.program)
  if (host === null) {
    return { ok: false, error: 'the converter sandbox needs bwrap and prlimit, which this host lacks' }
  }
  if (program === null) {
    return { ok: false, error: `${job.program} is not installed on this host` }
  }
  const release = await slot()
  let work: string | null = null
  try {
    work = workDir()
    return await runIn(work, job, host, program)
  } catch (e) {
    return { ok: false, error: `${job.program} could not run: ${e instanceof Error ? e.message : String(e)}` }
  } finally {
    if (work !== null) {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
    release()
  }
}
