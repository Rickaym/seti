import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type {
  ChildProcess,
  DiskUsage,
  HistoryPoint,
  HostResources,
  Resources,
  ResourceSummary,
  Task,
  TaskProcess,
} from '@seti/shared'
import { CLAUDE_HOME, SETI_HOME } from './config.js'
import { tasks } from './db.js'
import { environValue, hostCpuPercent, mountOf, parseMeminfo, Proc, type CpuTimes, type ProcStat } from './proc.js'
import {
  ageS,
  descendants,
  keyOf,
  scanProcesses,
  startedAt,
  sum,
  type Scan,
  type TickReadings,
} from './process-scan.js'
import { ComponentProbe } from './resource-components.js'
import { evaluateRules, type CpuPoint, type TaskCandidate } from './resource-rules.js'
import { TASK_ID_ENV } from './session-options.js'
import { sandboxPolicy } from './store/sandbox.js'
import { currentToolCall, type OpenToolCall } from './tool-calls.js'

const SAMPLE_INTERVAL_MS = 10_000
const HISTORY_MS = 60 * 60_000
/** Long enough for the hang rule to look back over a few minutes of one process. */
const CPU_TRAIL_MS = 5 * 60_000
const CHILDREN_SHOWN = 8
const UNMAPPED_LABEL = 'Claude Code without an agent'

/** A Claude Code process among the server's children, with the task its environment names. */
interface ClaudeProcess {
  stat: ProcStat
  taskId: string | null
}

type TaskRow = Omit<TaskProcess, 'flags'>

/** The server's children that are Claude Code: named `claude`, or started for a task. */
export function claudeProcesses(
  children: readonly ProcStat[],
  taskIdOf: (stat: ProcStat) => string | null,
): ClaudeProcess[] {
  return children.flatMap((stat) => {
    const taskId = taskIdOf(stat)
    return taskId !== null || stat.comm === 'claude' ? [{ stat, taskId }] : []
  })
}

const percentOf = (part: number, whole: number) => (whole === 0 ? 0 : (100 * part) / whole)

const treeRss = (row: Pick<TaskProcess, 'rss_bytes' | 'children'>) =>
  row.rss_bytes + sum(row.children.map((child) => child.rss_bytes))

const treeCpu = (row: Pick<TaskProcess, 'cpu_percent' | 'children'>) =>
  (row.cpu_percent ?? 0) + sum(row.children.map((child) => child.cpu_percent ?? 0))

const toolRow = (tool: OpenToolCall | null, now: number): TaskProcess['tool'] =>
  tool === null ? null : { name: tool.name, command: tool.command, age_s: Math.max(0, (now - tool.since) / 1000) }

const taskRef = (task: Task | undefined, sandboxOn: boolean): TaskProcess['task'] =>
  task === undefined
    ? null
    : { id: task.id, title: task.title, status: task.status, sandboxed: task.sandbox && sandboxOn }

/** Usage of the filesystem holding `place`, walking up to a parent that exists or can be read. */
function diskAt(place: string): { dir: string; disk: Omit<DiskUsage, 'mount' | 'holds'> } | null {
  for (let dir = path.resolve(place); ; dir = path.dirname(dir)) {
    try {
      const stats = fs.statfsSync(dir)
      const used = (stats.blocks - stats.bfree) * stats.bsize
      const free = stats.bavail * stats.bsize
      const disk = {
        total_bytes: stats.blocks * stats.bsize,
        used_bytes: used,
        free_bytes: free,
        used_percent: percentOf(used, used + free),
      }
      return { dir, disk }
    } catch {
      if (dir === path.dirname(dir)) {
        return null
      }
    }
  }
}

/** Reads /proc every interval and keeps the last hour; one per server process. */
export class ResourceSampler {
  private readonly proc: Proc
  private readonly serverPid: number
  private readonly components: ComponentProbe
  private readonly taskOfProcess = new Map<string, string | null>()
  private readings: TickReadings = new Map()
  private lastHost: CpuTimes | null = null
  private cpuTrails = new Map<string, readonly CpuPoint[]>()
  private history: HistoryPoint[] = []
  private costs: { wall: number; cpu: number }[] = []
  private latest: Resources | null = null
  private running: Promise<Resources> | null = null

  constructor(proc = new Proc(), serverPid = process.pid) {
    this.proc = proc
    this.serverPid = serverPid
    this.components = new ComponentProbe(proc, serverPid)
  }

  start(): void {
    void this.tick()
    setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS).unref()
  }

  async current(): Promise<Resources> {
    return this.latest ?? this.sample()
  }

  async summary(): Promise<ResourceSummary> {
    const latest = await this.current()
    const { memory } = latest.host
    const first = latest.anomalies.at(0)
    return {
      sampled_at: latest.sampled_at,
      memory_percent: percentOf(memory.used_bytes, memory.total_bytes),
      cpu_percent: latest.host.cpu_percent,
      anomalies: latest.anomalies.length,
      severity: first?.severity ?? 'ok',
      headline: first?.message ?? null,
    }
  }

  private async tick(): Promise<void> {
    try {
      await this.sample()
    } catch (e) {
      process.stderr.write(`resource sample failed: ${e instanceof Error ? e.message : String(e)}\n`)
    }
  }

  /** Takes one sample; a caller that asks while one runs shares it. */
  async sample(): Promise<Resources> {
    this.running ??= this.measure().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async measure(): Promise<Resources> {
    const wallStart = performance.now()
    const cpuStart = process.cpuUsage()
    const { scan, readings } = scanProcesses(this.proc, this.readings, Date.now())
    this.readings = readings
    const components = await this.components.all(scan)
    const host = this.host(scan)
    const { rows, candidates } = await this.taskRows(scan)
    const { anomalies, flags } = evaluateRules({ now: scan.now, host, components, tasks: candidates })
    const taskRows = rows.map((row, i) => ({ ...row, flags: flags[i] ?? [] })).sort((a, b) => treeRss(b) - treeRss(a))
    const totals = {
      processes: sum(taskRows.map((row) => 1 + row.children.length)),
      rss_bytes: sum(taskRows.map(treeRss)),
      swap_bytes: sum(taskRows.map((row) => row.swap_bytes)),
      cpu_percent: sum(taskRows.map(treeCpu)),
    }
    const sampledAt = new Date(scan.now).toISOString()
    this.history = [
      ...this.history.filter((point) => Date.parse(point.at) > scan.now - HISTORY_MS),
      {
        at: sampledAt,
        cpu_percent: host.cpu_percent,
        memory_percent: percentOf(host.memory.used_bytes, host.memory.total_bytes),
        task_rss_bytes: totals.rss_bytes,
      },
    ]
    const cpuUsed = process.cpuUsage(cpuStart)
    this.costs = [
      ...this.costs.slice(1 - this.history.length),
      { wall: performance.now() - wallStart, cpu: (cpuUsed.user + cpuUsed.system) / 1000 },
    ]
    this.latest = {
      sampled_at: sampledAt,
      interval_s: SAMPLE_INTERVAL_MS / 1000,
      host,
      components,
      tasks: taskRows,
      totals,
      anomalies,
      history: this.history,
      sampler: {
        wall_ms: sum(this.costs.map((c) => c.wall)) / this.costs.length,
        cpu_ms: sum(this.costs.map((c) => c.cpu)) / this.costs.length,
      },
    }
    return this.latest
  }

  private host(scan: Scan): HostResources {
    const mem = parseMeminfo(this.proc.read('meminfo') ?? '')
    const cpuPercent = hostCpuPercent(this.lastHost, scan.host)
    this.lastHost = scan.host
    const [one = 0, five = 0, fifteen = 0] = os.loadavg()
    return {
      cpus: os.availableParallelism(),
      load: [one, five, fifteen],
      cpu_percent: cpuPercent,
      memory: {
        total_bytes: mem.totalBytes,
        used_bytes: mem.totalBytes - mem.availableBytes,
        available_bytes: mem.availableBytes,
      },
      swap: { total_bytes: mem.swapTotalBytes, used_bytes: mem.swapTotalBytes - mem.swapFreeBytes },
      disks: this.disks(),
      uptime_s: os.uptime(),
    }
  }

  /** The filesystems holding Seti's home, the Postgres data and Claude's home, one row per mount. */
  private disks(): DiskUsage[] {
    const mounts = this.proc.read('self', 'mounts') ?? ''
    const places: [string, string | null][] = [
      ['Seti home', SETI_HOME],
      ['Postgres data', this.components.dataDir],
      ['Claude home', CLAUDE_HOME],
    ]
    const byMount = new Map<string, DiskUsage>()
    for (const [label, place] of places) {
      const usage = place === null ? null : diskAt(place)
      if (usage !== null) {
        const mount = mountOf(mounts, usage.dir)
        const holds = [...(byMount.get(mount)?.holds ?? []), label]
        byMount.set(mount, { ...usage.disk, mount, holds })
      }
    }
    return [...byMount.values()]
  }

  /** The task a process was started for, read from its environment once per process. */
  private taskIdOf(stat: ProcStat): string | null {
    const key = keyOf(stat)
    if (!this.taskOfProcess.has(key)) {
      const environ = this.proc.read(String(stat.pid), 'environ')
      this.taskOfProcess.set(key, environ === null ? null : environValue(environ, TASK_ID_ENV))
    }
    return this.taskOfProcess.get(key) ?? null
  }

  /** The process's CPU readings over the last few minutes, the newest last. */
  private cpuTrail(scan: Scan, stat: ProcStat): CpuPoint[] {
    const point = scan.cpu.get(stat.pid) ?? null
    const trail = [...(this.cpuTrails.get(keyOf(stat)) ?? []), ...(point === null ? [] : [point])]
    let span = sum(trail.map((p) => p.spanMs))
    while (trail.length > 1 && span - (trail[0]?.spanMs ?? 0) >= CPU_TRAIL_MS) {
      span -= trail.shift()?.spanMs ?? 0
    }
    return trail
  }

  private child(scan: Scan, stat: ProcStat): ChildProcess {
    return {
      pid: stat.pid,
      name: stat.comm,
      rss_bytes: this.proc.status(stat.pid)?.rssBytes ?? 0,
      cpu_percent: scan.cpu.get(stat.pid)?.percent ?? null,
      age_s: ageS(scan, stat),
    }
  }

  private async taskRow(
    scan: Scan,
    { stat, taskId }: ClaudeProcess,
    sandboxOn: boolean,
  ): Promise<{ row: TaskRow; candidate: TaskCandidate }> {
    const task = taskId === null ? undefined : await tasks.get(taskId).catch(() => undefined)
    const status = this.proc.status(stat.pid)
    const kids = descendants(scan.children, stat.pid)
    const tool = task === undefined ? null : currentToolCall(task.id)
    const rssBytes = status?.rssBytes ?? 0
    const row = {
      pid: stat.pid,
      task: taskRef(task, sandboxOn),
      rss_bytes: rssBytes,
      swap_bytes: status?.swapBytes ?? 0,
      cpu_percent: scan.cpu.get(stat.pid)?.percent ?? null,
      threads: status?.threads ?? stat.threads,
      age_s: ageS(scan, stat),
      tool: toolRow(tool, scan.now),
      children: kids.slice(0, CHILDREN_SHOWN).map((kid) => this.child(scan, kid)),
    }
    const candidate = {
      taskId: task?.id ?? null,
      label: task?.title ?? UNMAPPED_LABEL,
      rssBytes,
      cpu: this.cpuTrail(scan, stat),
      tool,
      childStarts: kids.map((kid) => startedAt(scan, kid)),
    }
    return { row, candidate }
  }

  private async taskRows(scan: Scan): Promise<{ rows: TaskRow[]; candidates: TaskCandidate[] }> {
    const found = claudeProcesses(scan.children.get(this.serverPid) ?? [], (stat) => this.taskIdOf(stat))
    const sandboxOn = (await sandboxPolicy.get().catch(() => null))?.enabled === true
    const measured = await Promise.all(found.map(async (claude) => this.taskRow(scan, claude, sandboxOn)))
    this.cpuTrails = new Map(found.map(({ stat }, i) => [keyOf(stat), measured[i]?.candidate.cpu ?? []]))
    for (const key of this.taskOfProcess.keys()) {
      if (!this.readings.has(key)) {
        this.taskOfProcess.delete(key)
      }
    }
    return { rows: measured.map((m) => m.row), candidates: measured.map((m) => m.candidate) }
  }
}

export const resourceSampler = new ResourceSampler()
