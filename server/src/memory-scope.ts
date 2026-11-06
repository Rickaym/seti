import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { CpuCap, MemoryCap, MemoryReport, MemoryScope, OomVictims } from '@seti/shared'
import { binaryPath } from './binaries.js'
import { PORT, SETI_HOME } from './config.js'
import { kernelOomKills, ToolGuard, type OomKill } from './oom-guard.js'
import { Proc } from './proc.js'
import { cpuProperties } from './scope-cpu.js'

const run = promisify(execFile)

export const CGROUP_ROOT = '/sys/fs/cgroup'
const LOCATE_MS = 3000
const LOCATE_POLL_MS = 20
/** How often the guard looks for new processes in each scope; a tool is at risk until it does. */
const GUARD_TICK_MS = 100
/** Kills in one burst, such as tsc and then chrome, become one note after this wait. */
const REPORT_DELAY_MS = 500
const REPORT_RETRY_MS = 2000
const KILL_LOG_SLACK_MS = 10_000
/** How bash and bwrap exit when the process they wait on is SIGKILLed, as the OOM killer does. */
const KILLED_EXIT = 128 + os.constants.signals.SIGKILL
/** How long a stopping scope's processes get after SIGTERM; a restart of Seti waits this long. */
const STOP_TIMEOUT_S = 10

export type ScopeKind = MemoryScope['kind']

/** How this host starts systemd scopes: the tools, the user bus and the unit scopes stop with. */
export interface ScopeHost {
  systemdRun: string
  systemctl: string
  /** XDG_RUNTIME_DIR, where systemd-run finds the user manager's bus. */
  runtimeDir: string
  /** The unit Seti runs in, so its scopes stop when it stops or restarts. */
  bindTo: string | null
  /** The user manager has the cpu controller, so a scope's CPU weight and ceiling hold. */
  cpu: boolean
}

/** A process tree to start in a scope of its own, held to the cap. */
export interface ScopePlan {
  host: ScopeHost
  taskId: string
  kind: ScopeKind
  cap: MemoryCap
  cpu: CpuCap
}

/** The systemd properties that hold a scope to `cap`; a throttle point at the cap means none. */
export function capProperties(cap: MemoryCap): string[] {
  const high = cap.high_mb >= cap.max_mb ? 'infinity' : `${String(cap.high_mb)}M`
  return [`MemoryHigh=${high}`, `MemoryMax=${String(cap.max_mb)}M`, `MemorySwapMax=${String(cap.swap_max_mb)}M`]
}

/**
 * systemd-run arguments that exec `command` in a new transient scope: the kernel stops one of
 * its processes at the cap and the rest go on, and the unit is gone once its processes are.
 * A stop or restart of Seti's unit stops the scope after Seti; BindsTo= alone passes a restart
 * on as try-restart, which a scope cannot do, so the scope would outlive the old Seti.
 */
export function scopeArgs(
  scope: { unit: string; cap: MemoryCap; cpu: CpuCap | null; bindTo: string | null },
  command: string,
  args: readonly string[],
): string[] {
  const properties = [
    ...capProperties(scope.cap),
    ...(scope.cpu === null ? [] : cpuProperties(scope.cpu)),
    'OOMPolicy=continue',
    `TimeoutStopSec=${String(STOP_TIMEOUT_S)}s`,
    ...(scope.bindTo === null
      ? []
      : [`BindsTo=${scope.bindTo}`, `StopPropagatedFrom=${scope.bindTo}`, `Before=${scope.bindTo}`]),
  ]
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${scope.unit}`,
    ...properties.flatMap((property) => ['-p', property]),
    '--',
    command,
    ...args,
  ]
}

/** The path of the unified (v2) hierarchy in a /proc cgroup file, or null without one. */
export function unifiedPath(cgroupFile: string): string | null {
  for (const line of cgroupFile.split('\n')) {
    const [id, controllers, ...rest] = line.split(':')
    if (id === '0' && controllers === '' && rest.length > 0) {
      return rest.join(':')
    }
  }
  return null
}

/** The unit of the user manager a process runs in, from its /proc cgroup file; null outside one. */
export function ownUnit(cgroupFile: string, uid: number): string | null {
  const unified = unifiedPath(cgroupFile)
  const marker = `/user@${String(uid)}.service/`
  const at = unified?.indexOf(marker) ?? -1
  if (unified === null || at === -1) {
    return null
  }
  const leaf =
    unified
      .slice(at + marker.length)
      .split('/')
      .at(-1) ?? ''
  return /^[\w:.@-]+\.(service|scope)$/.test(leaf) ? leaf : null
}

/** This Seti's home and port, which the name of each of its scopes starts with. */
export const SCOPE_INSTANCE = createHash('sha256')
  .update(`${SETI_HOME}:${String(PORT)}`)
  .digest('hex')
  .slice(0, 8)

const ownUnits = new Set<string>()

/** A unit name no other scope has: this Seti instance, the task and a random suffix. */
export function unitName(taskId: string, kind: ScopeKind): string {
  const task = taskId.replace(/[^\w-]/g, '_')
  const unit = `seti-${SCOPE_INSTANCE}-${kind}-${task}-${randomBytes(4).toString('hex')}.scope`
  ownUnits.add(unit)
  return unit
}

/** True for a scope this process named, and so may have started; the rest are an earlier run's. */
export const startedHere = (unit: string) => ownUnits.has(unit)

export function parseEvents(text: string): { oom_kill: number; high: number } {
  const counts = new Map(
    text
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key ?? '', Number(value)] as const),
  )
  return { oom_kill: counts.get('oom_kill') ?? 0, high: counts.get('high') ?? 0 }
}

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function userCgroup(uid: number): string {
  return path.join(CGROUP_ROOT, 'user.slice', `user-${String(uid)}.slice`, `user@${String(uid)}.service`)
}

/** Where systemd-run and systemctl find the user bus, also from a system service with no session. */
export const userBus = (host: ScopeHost) => ({
  env: { PATH: process.env.PATH ?? '', XDG_RUNTIME_DIR: host.runtimeDir },
})

/** The controllers the user manager has, which its scopes can use. */
const delegated = (uid: number) => (readText(path.join(userCgroup(uid), 'cgroup.subtree_control')) ?? '').split(/\s+/)

/** Why this host cannot hold agents to a memory cap, or null when it can. */
async function probe(host: ScopeHost, uid: number): Promise<string | null> {
  if (!delegated(uid).includes('memory')) {
    return 'the user manager has no memory controller delegated'
  }
  if (!fs.existsSync(path.join(host.runtimeDir, 'bus'))) {
    return `there is no user bus in ${host.runtimeDir}`
  }
  const cap = { high_mb: 64, max_mb: 64, swap_max_mb: 0 }
  const cpu = host.cpu ? { quota_percent: 100 } : null
  const args = scopeArgs({ unit: unitName('probe', 'agent'), cap, cpu, bindTo: null }, 'true', [])
  try {
    await run(host.systemdRun, args, userBus(host))
  } catch (e) {
    return `systemd-run failed: ${e instanceof Error ? e.message : String(e)}`
  }
  return null
}

/** How to start scopes on this host, checked now; SETI_MEMORY_SCOPES=off turns them off. */
export async function detectScopeHost(enabled = process.env.SETI_MEMORY_SCOPES !== 'off'): Promise<ScopeHost | null> {
  const systemdRun = binaryPath('systemd-run')
  const systemctl = binaryPath('systemctl')
  if (!enabled || systemdRun === null || systemctl === null) {
    return null
  }
  const { uid } = os.userInfo()
  const host: ScopeHost = {
    systemdRun,
    systemctl,
    runtimeDir: process.env.XDG_RUNTIME_DIR ?? `/run/user/${String(uid)}`,
    bindTo: ownUnit(readText('/proc/self/cgroup') ?? '', uid),
    cpu: delegated(uid).includes('cpu'),
  }
  const problem = await probe(host, uid)
  if (problem !== null) {
    process.stderr.write(`memory: agents run without a memory cap: ${problem}\n`)
    return null
  }
  if (!host.cpu) {
    process.stderr.write('cpu: agents run without a CPU cap: the user manager has no cpu controller delegated\n')
  }
  return host
}

let found: Promise<ScopeHost | null> | null = null

/** How to start scopes on this host, or null when it cannot; looked up once. */
export async function scopeHost(): Promise<ScopeHost | null> {
  found ??= detectScopeHost()
  return found
}

type MemoryListener = (taskId: string, report: MemoryReport) => void

let listener: MemoryListener | null = null

/** Called when a process of a task's scope is stopped at its cap, or the scope first throttles. */
export function onMemoryEvent(next: MemoryListener): void {
  listener = next
}

const parsePids = (text: string) =>
  text
    .split('\n')
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)

/** What Seti knows of a live scope: its plan, the limits it holds now and its cgroup directory. */
export interface ScopeLimits {
  readonly unit: string
  readonly plan: ScopePlan
  cap: MemoryCap
  cpu: CpuCap
  readonly dir: string | null
}

/** A scope Seti started, from launch until its first process exits. */
class LiveScope implements ScopeLimits {
  readonly unit: string
  readonly plan: ScopePlan
  cap: MemoryCap
  cpu: CpuCap
  dir: string | null = null
  private seen = { oom_kill: 0, high: 0 }
  private watcher: fs.FSWatcher | null = null
  private readonly guard: ToolGuard
  private pendingKills = 0
  /** Kills a report already named before memory.events counted them. */
  private namedAhead = 0
  private firstKillAt = 0
  private reporting = false
  private readonly reported = new Set<number>()
  private readonly started = Date.now()
  /** The run was killed after its scope was gone, so only the kernel log can tell an OOM kill. */
  private unread = false

  constructor(unit: string, plan: ScopePlan, launchPid: number) {
    this.unit = unit
    this.plan = plan
    this.cap = plan.cap
    this.cpu = plan.cpu
    this.guard = new ToolGuard(new Proc(), launchPid)
  }

  /** False when the scope's counts cannot be read, as before it is found or once it is gone. */
  check(): boolean {
    const text = this.dir === null ? null : readText(path.join(this.dir, 'memory.events'))
    if (text === null) {
      return false
    }
    const events = parseEvents(text)
    if (events.oom_kill > this.seen.oom_kill) {
      this.noteKills(events.oom_kill - this.seen.oom_kill)
    } else if (events.high > 0 && this.seen.high === 0) {
      listener?.(this.plan.taskId, { event: 'high', cap: this.cap, kind: this.plan.kind, victims: null })
    }
    this.seen = events
    return true
  }

  tick(): void {
    const text = this.dir === null ? null : readText(path.join(this.dir, 'cgroup.procs'))
    if (text !== null) {
      this.guard.tick(parsePids(text))
    }
  }

  private noteKills(count: number): void {
    const ahead = Math.min(count, this.namedAhead)
    this.namedAhead -= ahead
    if (count === ahead) {
      return
    }
    if (this.pendingKills === 0) {
      this.firstKillAt = Date.now()
    }
    this.pendingKills += count - ahead
    if (!this.reporting) {
      this.scheduleReport(REPORT_DELAY_MS, false)
    }
  }

  private scheduleReport(ms: number, retried: boolean): void {
    this.reporting = true
    setTimeout(() => void this.report(retried), ms).unref()
  }

  /** What the kills stopped: the kernel log names them where Seti may read it, else /proc tells. */
  private victims(kills: readonly OomKill[] | null): OomVictims {
    if (kills === null || kills.length === 0) {
      return { root: this.guard.rootGone(), names: [] }
    }
    const tools = kills.filter((kill) => !this.guard.isRoot(kill.pid))
    return {
      root: tools.length < kills.length,
      names: tools.map((kill) => this.guard.labelOf(kill.pid, kill.comm) ?? kill.comm),
    }
  }

  private async report(retried: boolean): Promise<void> {
    const counted = this.pendingKills
    const logged = await kernelOomKills(this.unit, this.firstKillAt - KILL_LOG_SLACK_MS)
    const kills = logged?.filter((kill) => !this.reported.has(kill.pid)) ?? null
    const logCount = kills?.length ?? 0
    if (kills !== null && logCount < Math.max(counted, this.unread ? 1 : 0) && !retried) {
      this.scheduleReport(REPORT_RETRY_MS, true)
      return
    }
    this.reporting = false
    if (counted === 0 && logCount === 0) {
      return
    }
    this.account(counted, kills ?? [])
    const victims = this.victims(kills)
    listener?.(this.plan.taskId, { event: 'oom_kill', cap: this.cap, kind: this.plan.kind, victims })
    if (this.pendingKills > 0) {
      this.scheduleReport(REPORT_DELAY_MS, false)
    }
  }

  /** Marks the logged kills reported and takes the kills a report names off the counted ones. */
  private account(counted: number, kills: readonly OomKill[]): void {
    for (const kill of kills) {
      this.reported.add(kill.pid)
    }
    const named = Math.max(counted, kills.length)
    const fromPending = Math.min(named, this.pendingKills)
    this.pendingKills -= fromPending
    this.namedAhead += named - fromPending
  }

  /** Waits for systemd-run to move the process into the scope, then watches its events. */
  async watch(pid: number, stillLive: () => boolean): Promise<void> {
    const until = Date.now() + LOCATE_MS
    while (Date.now() < until && stillLive()) {
      const unified = unifiedPath(readText(`/proc/${String(pid)}/cgroup`) ?? '')
      if (unified?.endsWith(`/${this.unit}`) === true) {
        this.dir = path.join(CGROUP_ROOT, unified)
        this.watchEvents(path.join(this.dir, 'memory.events'))
        this.tick()
        this.check()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, LOCATE_POLL_MS))
    }
  }

  private watchEvents(file: string): void {
    try {
      const watcher = fs.watch(file, () => {
        this.check()
      })
      watcher.on('error', () => {
        watcher.close()
      })
      this.watcher = watcher
    } catch {
      this.watcher = null
    }
  }

  /**
   * Reads the last counts. systemd removes the scope as its last process dies, often before
   * the kernel's oom_kill notice reaches the watcher, so a killed run then asks the kernel log.
   */
  end(killed: boolean): void {
    const read = this.check()
    this.watcher?.close()
    if (read || !killed) {
      return
    }
    this.unread = true
    if (this.pendingKills === 0) {
      this.firstKillAt = this.started
    }
    if (!this.reporting) {
      this.scheduleReport(REPORT_DELAY_MS, false)
    }
  }
}

const live = new Map<string, LiveScope>()

let ticker: NodeJS.Timeout | null = null

function startGuards(): void {
  ticker ??= setInterval(() => {
    for (const scope of live.values()) {
      scope.tick()
    }
    if (live.size === 0 && ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }, GUARD_TICK_MS).unref()
}

/** What `launch` needs of a started process: a child process, or a pseudo-terminal's adapter. */
export interface Launched {
  readonly pid?: number | undefined
  once: (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown
}

/** Starts `command` in a scope when there is a plan, else as it is; `start` does the spawning. */
export function launch<T extends Launched>(
  plan: ScopePlan | null,
  command: string,
  args: readonly string[],
  start: (command: string, args: string[]) => T,
): T {
  if (plan === null) {
    return start(command, [...args])
  }
  const unit = unitName(plan.taskId, plan.kind)
  const cpu = plan.host.cpu ? plan.cpu : null
  const child = start(
    plan.host.systemdRun,
    scopeArgs({ unit, cap: plan.cap, cpu, bindTo: plan.host.bindTo }, command, args),
  )
  if (child.pid === undefined) {
    return child
  }
  const scope = new LiveScope(unit, plan, child.pid)
  live.set(unit, scope)
  startGuards()
  child.once('exit', (code, signal) => {
    scope.end(signal === 'SIGKILL' || code === KILLED_EXIT)
    live.delete(unit)
  })
  void scope.watch(child.pid, () => live.has(unit))
  return child
}

/** The scopes Seti started that still run. */
export const liveScopes = (): ScopeLimits[] => [...live.values()]

export const isLive = (unit: string) => live.has(unit)
