import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProcess, AgentProcesses, AgentProcessKind, BackgroundShell, ShellOutput } from '@seti/shared'
import { displayCommand, shellIndex } from './background-shells.js'
import { HttpError } from './http.js'
import { childLookup, CLOCK_TICKS, environValue, parseBootTime, Proc, type ProcStat } from './proc.js'
import { scopeCpu, scopeMemory } from './scope-limits.js'
import { redactCredentials } from './scrub.js'
import { TASK_ID_ENV } from './session-options.js'
import { openChecked } from './task-files.js'
import { sandboxTmpDir } from './task-sandbox.js'
import { agentTerminals } from './terminal.js'

const CACHE_MS = 1000
const PROCESS_COMMAND_CHARS = 400
const TAIL_BYTES = 32 * 1024
const TAIL_LINES = 200
/** How long a stopped process gets to exit on SIGTERM before it gets SIGKILL. */
const STOP_GRACE_MS = 3000
const STOP_POLL_MS = 100

const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'fish', 'ksh'])
const OUTPUT_FILE = /\/tasks\/([\w-]+)\.output$/
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g')

/** Where the server and the task's processes live; tests point it at fixtures and their own pid. */
export interface ProcessHost {
  proc: Proc
  serverPid: number
}

const defaultHost: ProcessHost = { proc: new Proc(), serverPid: process.pid }

interface Node {
  stat: ProcStat
  argv: string[]
  depth: number
  kind: AgentProcessKind
  /** Claude Code or a process it started is above this one. */
  underAgent: boolean
  shellId: string | null
}

/** Command lines that are Seti's own: the sandbox, its init and the bridges to the task proxy. */
function isSetiHelper(stat: ProcStat, argv: readonly string[]): boolean {
  if (stat.comm === 'bwrap' || stat.comm === 'setpriv') {
    return true
  }
  return stat.comm === 'socat' && argv.some((arg) => arg.includes('proxy.sock') || arg.includes('proxyport='))
}

const environs = new Map<string, string | null>()

function taskIdOf(proc: Proc, stat: ProcStat): string | null {
  const key = `${String(stat.pid)}:${String(stat.startTicks)}`
  if (!environs.has(key)) {
    if (environs.size > 1000) {
      environs.clear()
    }
    const environ = proc.read(String(stat.pid), 'environ')
    environs.set(key, environ === null ? null : environValue(environ, TASK_ID_ENV))
  }
  return environs.get(key) ?? null
}

/** Seti's helpers by their command line; Claude Code is the first process below them. */
function kindOf(stat: ProcStat, argv: readonly string[], parent: Node | null): AgentProcessKind {
  if (isSetiHelper(stat, argv)) {
    return 'seti'
  }
  if (parent === null || (parent.kind === 'seti' && !parent.underAgent)) {
    return 'agent'
  }
  if (parent.kind === 'agent') {
    return SHELL_NAMES.has(stat.comm) ? 'command' : 'tool'
  }
  return parent.kind
}

/** Every live process of the task, parents before their children, siblings by pid. */
function taskTree(host: ProcessHost, taskId: string): Node[] {
  const { proc } = host
  const children = childLookup(proc)
  const nodes: Node[] = []
  const visit = (pid: number, parent: Node | null) => {
    const stat = proc.stat(pid)
    if (stat === null || stat.state === 'Z' || (parent !== null && stat.ppid !== parent.stat.pid)) {
      return
    }
    const argv = proc.cmdline(pid)
    const node: Node = {
      stat,
      argv,
      depth: parent === null ? 0 : parent.depth + 1,
      kind: kindOf(stat, argv, parent),
      underAgent: parent !== null && (parent.underAgent || parent.kind === 'agent'),
      shellId: null,
    }
    nodes.push(node)
    for (const child of children(pid).sort((a, b) => a - b)) {
      visit(child, node)
    }
  }
  for (const pid of children(host.serverPid).sort((a, b) => a - b)) {
    const stat = proc.stat(pid)
    if (stat !== null && taskIdOf(proc, stat) === taskId) {
      visit(pid, null)
    }
  }
  return nodes
}

const unquote = (text: string) => text.replaceAll(`'"'"'`, `'`)

/** Ties each running shell's process tree to it: by its output file, else by its command line. */
function linkShells(proc: Proc, nodes: readonly Node[], running: ReadonlyMap<string, string>): void {
  const byPid = new Map(nodes.map((node) => [node.stat.pid, node] as const))
  for (const node of nodes) {
    const parent = byPid.get(node.stat.ppid)
    if (parent?.kind !== 'agent' || node.kind !== 'command') {
      node.shellId = parent?.shellId ?? null
      continue
    }
    const byFile = proc
      .fdTargets(node.stat.pid)
      .map((target) => OUTPUT_FILE.exec(target)?.[1])
      .find((id) => id !== undefined && running.has(id))
    const line = unquote(node.argv.join(' '))
    const byCommand = [...running].find(([, command]) => command.trim() !== '' && line.includes(command.slice(0, 200)))
    node.shellId = byFile ?? byCommand?.[0] ?? null
  }
}

let bootMs: number | null = null

function startedAtMs(proc: Proc, stat: ProcStat): number {
  bootMs ??= parseBootTime(proc.read('stat') ?? '') * 1000
  return bootMs + (stat.startTicks * 1000) / CLOCK_TICKS
}

const readings = new Map<string, { ticks: number; at: number }>()

/** CPU since the previous look at the process, or over its whole life on the first look. */
function cpuPercent(proc: Proc, stat: ProcStat, now: number): number | null {
  const key = `${String(stat.pid)}:${String(stat.startTicks)}`
  const prev = readings.get(key)
  readings.set(key, { ticks: stat.cpuTicks, at: now })
  if (prev !== undefined && now - prev.at >= 200) {
    return Math.max(0, (100 * (stat.cpuTicks - prev.ticks)) / (((now - prev.at) / 1000) * CLOCK_TICKS))
  }
  const lifeS = (now - startedAtMs(proc, stat)) / 1000
  return lifeS <= 0 ? null : Math.max(0, (100 * stat.cpuTicks) / (lifeS * CLOCK_TICKS))
}

function pruneReadings(now: number): void {
  for (const [key, reading] of readings) {
    if (now - reading.at > 60_000) {
      readings.delete(key)
    }
  }
}

function toProcess(proc: Proc, node: Node, now: number): AgentProcess {
  const { stat } = node
  const status = proc.status(stat.pid)
  const nsPid = status?.nsPid ?? null
  return {
    pid: stat.pid,
    ns_pid: nsPid === stat.pid ? null : nsPid,
    ppid: stat.ppid,
    start_ticks: stat.startTicks,
    name: stat.comm,
    command: displayCommand(node.argv.length === 0 ? `[${stat.comm}]` : node.argv.join(' '), PROCESS_COMMAND_CHARS),
    kind: node.kind,
    shell_id: node.shellId,
    depth: node.depth,
    cpu_percent: cpuPercent(proc, stat, now),
    rss_bytes: status?.rssBytes ?? 0,
    elapsed_s: Math.max(0, (now - startedAtMs(proc, stat)) / 1000),
  }
}

type Shell = BackgroundShell & { output_file: string | null }

/** The task's background shells with what runs of them now, and its other processes. */
export async function readProcesses(
  taskId: string,
  openSince: number | null,
  host: ProcessHost = defaultHost,
): Promise<{ view: AgentProcesses; shells: Shell[] }> {
  const now = Date.now()
  const index = await shellIndex(taskId)
  const shells = index.shells(openSince)
  const running = index.runningCommands(openSince)
  const nodes = taskTree(host, taskId)
  linkShells(host.proc, nodes, running)
  const processes = nodes.map((node) => toProcess(host.proc, node, now))
  pruneReadings(now)
  const pids = new Map<string, number>()
  for (const p of processes) {
    if (p.shell_id !== null && !pids.has(p.shell_id)) {
      pids.set(p.shell_id, p.pid)
    }
  }
  for (const shell of shells) {
    shell.pid = shell.status === 'running' ? (pids.get(shell.id) ?? null) : null
  }
  const agentPids = new Set(processes.filter((p) => p.kind === 'agent').map((p) => p.pid))
  const loose = processes.filter((p) => p.kind === 'command' && p.shell_id === null && agentPids.has(p.ppid))
  const terminals = agentTerminals(taskId)
  const view: AgentProcesses = {
    sampled_at: new Date(now).toISOString(),
    open: openSince !== null,
    sandboxed: processes.some((p) => p.name === 'bwrap'),
    shells: shells.map(({ output_file: _file, ...shell }) => shell),
    processes,
    memory: scopeMemory(taskId),
    cpu: await scopeCpu(taskId),
    terminals,
    running: shells.filter((shell) => shell.status === 'running').length + loose.length + terminals.length,
  }
  return { view, shells }
}

const cached = new Map<string, { at: number; result: ReturnType<typeof readProcesses> }>()

/** The task's processes, read at most once a second however many viewers poll. */
export async function agentProcesses(taskId: string, openSince: number | null): Promise<AgentProcesses> {
  const hit = cached.get(taskId)
  const now = Date.now()
  if (hit !== undefined && now - hit.at < CACHE_MS) {
    return (await hit.result).view
  }
  const result = readProcesses(taskId, openSince)
  cached.set(taskId, { at: now, result })
  result.catch(() => cached.delete(taskId))
  return (await result).view
}

export function forgetProcesses(taskId: string): void {
  cached.delete(taskId)
}

const sameProcess = (proc: Proc, target: AgentProcess) => {
  const stat = proc.stat(target.pid)
  return stat !== null && stat.startTicks === target.start_ticks && stat.state !== 'Z'
}

function signal(proc: Proc, targets: readonly AgentProcess[], name: NodeJS.Signals): void {
  for (const target of targets) {
    if (sameProcess(proc, target)) {
      try {
        process.kill(target.pid, name)
      } catch {
        // It exited between the check and the signal.
      }
    }
  }
}

/** SIGTERM to the processes, then SIGKILL to those still running after the grace period. */
export async function terminate(
  targets: readonly AgentProcess[],
  host: ProcessHost = defaultHost,
  graceMs = STOP_GRACE_MS,
): Promise<void> {
  signal(host.proc, targets, 'SIGTERM')
  const until = Date.now() + graceMs
  while (Date.now() < until && targets.some((target) => sameProcess(host.proc, target))) {
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS))
  }
  signal(host.proc, targets, 'SIGKILL')
}

/** The process and everything below it, from one reading of the task's tree. */
export function subtreeOf(processes: readonly AgentProcess[], root: AgentProcess): AgentProcess[] {
  const found = [root]
  for (const candidate of processes) {
    if (found.some((p) => p.pid === candidate.ppid) && !found.includes(candidate)) {
      found.push(candidate)
    }
  }
  return found
}

/**
 * Finds a process the user may stop in the task's own tree. Claude Code and Seti's helpers are
 * refused; a pid that is not in the tree, or that a newer process took over, is not found.
 */
export function stoppable(processes: readonly AgentProcess[], pid: number, startTicks: number): AgentProcess {
  const target = processes.find((p) => p.pid === pid && p.start_ticks === startTicks)
  if (target === undefined) {
    throw new HttpError(404, 'That process is not running in this agent')
  }
  if (target.kind === 'agent') {
    throw new HttpError(409, 'That is Claude Code itself; stop the agent or end its session instead')
  }
  if (target.kind === 'seti') {
    throw new HttpError(409, "That is one of Seti's own helpers for this agent")
  }
  return target
}

const realDir = (dir: string) => {
  try {
    return fs.realpathSync(dir)
  } catch {
    return null
  }
}

/** Host paths the output file of a shell may be at: inside the task's sandbox, else on the host. */
function outputCandidates(taskId: string, shellId: string, file: string): string[] {
  if (OUTPUT_FILE.exec(file)?.[1] !== shellId || !/\/claude-\d+\//.test(file) || path.normalize(file) !== file) {
    return []
  }
  const sandboxTmp = realDir(sandboxTmpDir(taskId))
  const hostTmp = realDir(os.tmpdir())
  // eslint-disable-next-line sonarjs/publicly-writable-directories -- the sandbox's /tmp is its private host dir
  const inSandbox = sandboxTmp !== null && file.startsWith('/tmp/') ? [path.join(sandboxTmp, file.slice(5))] : []
  const onHost = hostTmp !== null && file.startsWith(`${hostTmp}/`) ? [file] : []
  return [...inSandbox, ...onHost]
}

function readTail(file: string): { text: string; size: number; truncated: boolean } {
  const fd = openChecked(file)
  try {
    const size = fs.fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    fs.readSync(fd, buffer, 0, length, size - length)
    let lines = buffer.toString('utf8').replace(ESCAPES, '').split('\n')
    const cut = size > length || lines.length > TAIL_LINES
    if (size > length) {
      lines = lines.slice(1)
    }
    return { text: lines.slice(-TAIL_LINES).join('\n'), size, truncated: cut }
  } finally {
    fs.closeSync(fd)
  }
}

/** The end of a background shell's output, read from the file Claude Code writes it to. */
export function shellOutput(taskId: string, shell: Shell): ShellOutput {
  const file = shell.output_file
  const at = file === null ? undefined : outputCandidates(taskId, shell.id, file).find((p) => fs.existsSync(p))
  if (at === undefined) {
    return { id: shell.id, text: '', size_bytes: 0, truncated: false }
  }
  let tail: ReturnType<typeof readTail>
  try {
    tail = readTail(at)
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(409, 'The output file of that shell cannot be read')
  }
  return { id: shell.id, text: redactCredentials(tail.text), size_bytes: tail.size, truncated: tail.truncated }
}
