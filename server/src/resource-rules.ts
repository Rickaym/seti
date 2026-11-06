import type { Anomaly, AnomalyRule, ComponentResources, HostResources } from '@seti/shared'

/** A task process at or above this share of one CPU counts as busy for the hang rule. */
export const HANG_CPU_PERCENT = 50
/** How long a tool call runs busy with no child process before it counts as hung. */
export const HANG_AFTER_MS = 60_000
/** A child that started this long before the tool call was stamped still belongs to it. */
const CHILD_SLACK_MS = 2000
/** Claude Code processes sit near 300 MB; this is five times that. */
export const TASK_MEMORY_BYTES = 1.5 * 1024 ** 3
export const HOST_MEMORY_PERCENT = 90
export const SWAP_FULL_PERCENT = 90
export const DISK_FULL_PERCENT = 90
/** One-minute load above this many runnable processes per CPU. */
export const LOAD_PER_CPU = 2

export interface CpuPoint {
  percent: number
  /** How long the reading covers, the time since the one before it. */
  spanMs: number
}

interface ToolCallState {
  name: string
  since: number
}

export interface TaskCandidate {
  taskId: string | null
  label: string
  rssBytes: number
  cpu: readonly CpuPoint[]
  tool: ToolCallState | null
  /** When each live descendant process started, in epoch ms. */
  childStarts: readonly number[]
}

export interface RuleInput {
  now: number
  host: HostResources
  components: readonly ComponentResources[]
  tasks: readonly TaskCandidate[]
}

export interface RuleResult {
  anomalies: Anomaly[]
  /** The rules each task candidate broke, in the order of the input. */
  flags: AnomalyRule[][]
}

/** The newest readings at or above `threshold`, back to the first dip below it. */
function busyStretch(points: readonly CpuPoint[], threshold: number): CpuPoint[] {
  const start = points.findLastIndex((point) => point.percent < threshold) + 1
  return points.slice(start)
}

export const sustainedMs = (points: readonly CpuPoint[], threshold: number): number =>
  busyStretch(points, threshold).reduce((sum, point) => sum + point.spanMs, 0)

const average = (points: readonly CpuPoint[]) => {
  const span = points.reduce((sum, p) => sum + p.spanMs, 0)
  return span === 0 ? 0 : points.reduce((sum, p) => sum + p.percent * p.spanMs, 0) / span
}

const gib = (value: number) => `${(value / 1024 ** 3).toFixed(1)} GB`
const minutes = (ms: number) =>
  ms < 120_000 ? `${String(Math.round(ms / 1000))} s` : `${String(Math.round(ms / 60_000))} min`

/** A tool call that has kept the process busy past HANG_AFTER_MS with no child process of its own. */
export function isHung(task: TaskCandidate, now: number): boolean {
  const { tool } = task
  if (tool === null || now - tool.since < HANG_AFTER_MS) {
    return false
  }
  if (task.childStarts.some((start) => start >= tool.since - CHILD_SLACK_MS)) {
    return false
  }
  return sustainedMs(task.cpu, HANG_CPU_PERCENT) >= HANG_AFTER_MS
}

function taskAnomalies(task: TaskCandidate, now: number): Anomaly[] {
  const found: Anomaly[] = []
  const base = { task_id: task.taskId, component: null, mount: null }
  if (isHung(task, now) && task.tool !== null) {
    const stretch = busyStretch(task.cpu, HANG_CPU_PERCENT)
    const busy = `${String(Math.round(average(stretch)))}% CPU for ${minutes(sustainedMs(stretch, 0))}`
    found.push({
      ...base,
      rule: 'hang',
      severity: 'critical',
      message: `${task.label}: ${busy} in ${task.tool.name} with no child process`,
    })
  }
  if (task.rssBytes >= TASK_MEMORY_BYTES) {
    found.push({
      ...base,
      rule: 'task_memory',
      severity: 'warning',
      message: `${task.label}: ${gib(task.rssBytes)} RSS`,
    })
  }
  return found
}

function hostAnomalies(host: HostResources): Anomaly[] {
  const found: Anomaly[] = []
  const base = { task_id: null, component: null, mount: null, severity: 'warning' as const }
  const { memory, swap } = host
  const memoryPercent = memory.total_bytes === 0 ? 0 : (100 * memory.used_bytes) / memory.total_bytes
  if (memoryPercent >= HOST_MEMORY_PERCENT) {
    found.push({ ...base, rule: 'host_memory', message: `Memory ${String(Math.round(memoryPercent))}% used` })
  }
  if (swap.total_bytes > 0 && (100 * swap.used_bytes) / swap.total_bytes >= SWAP_FULL_PERCENT) {
    found.push({ ...base, rule: 'swap', message: `Swap ${gib(swap.used_bytes)} of ${gib(swap.total_bytes)} used` })
  }
  for (const disk of host.disks) {
    if (disk.used_percent >= DISK_FULL_PERCENT) {
      const message = `Disk ${disk.mount} ${String(Math.round(disk.used_percent))}% full, ${gib(disk.free_bytes)} free`
      found.push({ ...base, rule: 'disk', message, mount: disk.mount })
    }
  }
  if (host.load[0] >= LOAD_PER_CPU * host.cpus) {
    found.push({ ...base, rule: 'load', message: `Load ${host.load[0].toFixed(1)} on ${String(host.cpus)} CPUs` })
  }
  return found
}

const componentAnomalies = (components: readonly ComponentResources[]): Anomaly[] =>
  components
    .filter((component) => component.state === 'down')
    .map((component) => ({
      rule: 'down',
      severity: 'warning',
      message: `${component.name} is down`,
      task_id: null,
      component: component.id,
      mount: null,
    }))

const SEVERITY_ORDER = { critical: 0, warning: 1 } as const

/** Every rule broken now, the most severe first. */
export function evaluateRules(input: RuleInput): RuleResult {
  const perTask = input.tasks.map((task) => taskAnomalies(task, input.now))
  const anomalies = [...perTask.flat(), ...hostAnomalies(input.host), ...componentAnomalies(input.components)]
  anomalies.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  return { anomalies, flags: perTask.map((found) => found.map((anomaly) => anomaly.rule)) }
}
