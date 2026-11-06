import { z } from 'zod'
import { TASK_STATUSES } from './tasks.js'

export const ANOMALY_RULES = ['hang', 'task_memory', 'host_memory', 'swap', 'disk', 'load', 'down'] as const

export type AnomalyRule = (typeof ANOMALY_RULES)[number]

export const COMPONENT_IDS = ['server', 'ea', 'postgres', 'redis', 'cloudflared'] as const

export type ComponentId = (typeof COMPONENT_IDS)[number]

const bytes = z.number().nonnegative()
/** Percent of one CPU for a process, so a busy multi-threaded process can pass 100. */
const cpuPercent = z.number().nonnegative().nullable()

export const anomalySchema = z.object({
  rule: z.enum(ANOMALY_RULES),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
  task_id: z.string().nullable(),
  component: z.enum(COMPONENT_IDS).nullable(),
  /** The mount point a disk anomaly is about. */
  mount: z.string().nullable(),
})

export type Anomaly = z.infer<typeof anomalySchema>

export const diskSchema = z.object({
  mount: z.string(),
  /** What Seti keeps there: Seti home, Postgres data, Claude home. */
  holds: z.array(z.string()),
  total_bytes: bytes,
  used_bytes: bytes,
  free_bytes: bytes,
  used_percent: z.number(),
})

export type DiskUsage = z.infer<typeof diskSchema>

export const hostSchema = z.object({
  cpus: z.number().int().positive(),
  load: z.tuple([z.number(), z.number(), z.number()]),
  /** Share of all CPUs busy over the last sample interval, 0 to 100. */
  cpu_percent: z.number().nullable(),
  memory: z.object({ total_bytes: bytes, used_bytes: bytes, available_bytes: bytes }),
  swap: z.object({ total_bytes: bytes, used_bytes: bytes }),
  disks: z.array(diskSchema),
  uptime_s: z.number().nonnegative(),
})

export type HostResources = z.infer<typeof hostSchema>

export const componentSchema = z.object({
  id: z.enum(COMPONENT_IDS),
  name: z.string(),
  /** `off` is a component this instance is not set up to use. */
  state: z.enum(['up', 'down', 'off']),
  pid: z.number().int().nullable(),
  processes: z.number().int().nonnegative(),
  rss_bytes: bytes,
  cpu_percent: cpuPercent,
  uptime_s: z.number().nonnegative().nullable(),
  /** A figure of the component's own, such as the database size or Redis used_memory. */
  detail: z.object({ label: z.string(), bytes }).nullable(),
})

export type ComponentResources = z.infer<typeof componentSchema>

export const childProcessSchema = z.object({
  pid: z.number().int(),
  name: z.string(),
  rss_bytes: bytes,
  cpu_percent: cpuPercent,
  age_s: z.number().nonnegative(),
})

export type ChildProcess = z.infer<typeof childProcessSchema>

export const taskProcessSchema = z.object({
  pid: z.number().int(),
  /** Null for a Claude Code process that serves no task, such as a capability probe. */
  task: z
    .object({
      id: z.string(),
      title: z.string(),
      status: z.enum(TASK_STATUSES),
      sandboxed: z.boolean(),
    })
    .nullable(),
  rss_bytes: bytes,
  swap_bytes: bytes,
  cpu_percent: cpuPercent,
  threads: z.number().int().nonnegative(),
  age_s: z.number().nonnegative(),
  /** The tool call in progress: the Bash command from the transcript, or only the tool name. */
  tool: z.object({ name: z.string(), command: z.string().nullable(), age_s: z.number().nonnegative() }).nullable(),
  children: z.array(childProcessSchema),
  flags: z.array(z.enum(ANOMALY_RULES)),
})

export type TaskProcess = z.infer<typeof taskProcessSchema>

export const historyPointSchema = z.object({
  at: z.string(),
  cpu_percent: z.number().nullable(),
  memory_percent: z.number(),
  task_rss_bytes: bytes,
})

export type HistoryPoint = z.infer<typeof historyPointSchema>

export const resourcesSchema = z.object({
  sampled_at: z.string(),
  interval_s: z.number().positive(),
  host: hostSchema,
  components: z.array(componentSchema),
  tasks: z.array(taskProcessSchema),
  totals: z.object({ processes: z.number().int(), rss_bytes: bytes, swap_bytes: bytes, cpu_percent: z.number() }),
  anomalies: z.array(anomalySchema),
  history: z.array(historyPointSchema),
  /** What the sampler itself costs per sample, averaged over the kept history. */
  sampler: z.object({ wall_ms: z.number(), cpu_ms: z.number() }),
})

export type Resources = z.infer<typeof resourcesSchema>

export const resourceSummarySchema = z.object({
  sampled_at: z.string(),
  memory_percent: z.number(),
  cpu_percent: z.number().nullable(),
  anomalies: z.number().int().nonnegative(),
  severity: z.enum(['ok', 'warning', 'critical']),
  /** The first anomaly's message, for the status bar tooltip. */
  headline: z.string().nullable(),
})

export type ResourceSummary = z.infer<typeof resourceSummarySchema>
