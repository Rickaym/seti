import {
  CLOCK_TICKS,
  parseBootTime,
  parseCpuTimes,
  processCpuPercent,
  type CpuTimes,
  type Proc,
  type ProcStat,
} from './proc.js'
import type { CpuPoint } from './resource-rules.js'

/** Every process on the host at one moment, with its CPU use since the scan before. */
export interface Scan {
  now: number
  bootMs: number
  host: CpuTimes
  byPid: Map<number, ProcStat>
  children: Map<number, ProcStat[]>
  /** Null for a process that started since the scan before. */
  cpu: Map<number, CpuPoint | null>
}

export type TickReadings = Map<string, { ticks: number; at: number }>

/** A pid with its start time, which stays unique when the kernel reuses the pid. */
export const keyOf = (stat: ProcStat) => `${String(stat.pid)}:${String(stat.startTicks)}`

export const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

/** Reads every process's stat once; returns the scan and the readings the next scan compares to. */
export function scanProcesses(proc: Proc, previous: TickReadings, now: number): { scan: Scan; readings: TickReadings } {
  const statText = proc.read('stat') ?? ''
  const processes = proc.processes()
  const children = new Map<number, ProcStat[]>()
  const cpu = new Map<number, CpuPoint | null>()
  const readings: TickReadings = new Map()
  for (const stat of processes) {
    const siblings = children.get(stat.ppid)
    if (siblings === undefined) {
      children.set(stat.ppid, [stat])
    } else {
      siblings.push(stat)
    }
    const key = keyOf(stat)
    const prev = previous.get(key)
    const percent = prev === undefined ? null : processCpuPercent(prev.ticks, stat.cpuTicks, now - prev.at)
    cpu.set(stat.pid, percent === null || prev === undefined ? null : { percent, spanMs: now - prev.at })
    readings.set(key, { ticks: stat.cpuTicks, at: now })
  }
  const scan = {
    now,
    bootMs: parseBootTime(statText) * 1000,
    host: parseCpuTimes(statText),
    byPid: new Map(processes.map((stat) => [stat.pid, stat])),
    children,
    cpu,
  }
  return { scan, readings }
}

export const startedAt = (scan: Scan, stat: ProcStat) => scan.bootMs + (stat.startTicks * 1000) / CLOCK_TICKS

export const ageS = (scan: Scan, stat: ProcStat) => Math.max(0, (scan.now - startedAt(scan, stat)) / 1000)

/** Every process below `pid`, parents before their children. */
export function descendants(children: ReadonlyMap<number, readonly ProcStat[]>, pid: number): ProcStat[] {
  const found: ProcStat[] = []
  const seen = new Set([pid])
  const queue = [...(children.get(pid) ?? [])]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (!seen.has(next.pid)) {
      seen.add(next.pid)
      found.push(next)
      queue.push(...(children.get(next.pid) ?? []))
    }
  }
  return found
}

/** Memory and CPU of a group of processes: private pages added up, shared pages counted once. */
export function groupUsage(proc: Proc, scan: Scan, members: readonly ProcStat[]) {
  const statuses = members.flatMap((stat) => {
    const status = proc.status(stat.pid)
    return status === null ? [] : [status]
  })
  const readings = members.flatMap((stat) => {
    const point = scan.cpu.get(stat.pid) ?? null
    return point === null ? [] : [point.percent]
  })
  return {
    processes: members.length,
    rss_bytes: sum(statuses.map((s) => s.anonBytes)) + Math.max(0, ...statuses.map((s) => s.sharedBytes)),
    cpu_percent: readings.length === 0 ? null : sum(readings),
  }
}
