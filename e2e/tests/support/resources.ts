import type { Page } from '@playwright/test'
import type { Envelope, Resources, ResourceSummary, TaskProcess } from '@seti/shared'

const GB = 1024 ** 3
const MB = 1024 ** 2

export const HUNG_TASK = { id: 'e2e-hung-task', title: 'Refactor the poller' }
export const QUIET_TASK = { id: 'e2e-quiet-task', title: 'Write the changelog' }

const task = (over: Partial<TaskProcess>): TaskProcess => ({
  pid: 5000,
  task: null,
  rss_bytes: 300 * MB,
  swap_bytes: 0,
  cpu_percent: 1,
  threads: 21,
  age_s: 600,
  tool: null,
  children: [],
  flags: [],
  ...over,
})

/** Six minutes of history sampled every 10 s, climbing towards the incident. */
const history = Array.from({ length: 36 }, (_, i) => ({
  at: new Date(Date.UTC(2026, 8, 28, 9, 0, i * 10)).toISOString(),
  cpu_percent: 20 + i * 2,
  memory_percent: 40 + i,
  task_rss_bytes: (1 + i / 6) * GB,
}))

/** A host in the state of the day six tasks hung: swap nearly full and one task spinning. */
const RESOURCES: Resources = {
  sampled_at: new Date(Date.UTC(2026, 8, 28, 9, 6, 0)).toISOString(),
  interval_s: 10,
  host: {
    cpus: 8,
    load: [17.2, 15.1, 11.8],
    cpu_percent: 91,
    memory: { total_bytes: 30 * GB, used_bytes: 22 * GB, available_bytes: 8 * GB },
    swap: { total_bytes: 8 * GB, used_bytes: 7.8 * GB },
    disks: [
      {
        mount: '/',
        holds: ['Seti home', 'Postgres data', 'Claude home'],
        total_bytes: 247 * GB,
        used_bytes: 194 * GB,
        free_bytes: 53 * GB,
        used_percent: 78.5,
      },
    ],
    uptime_s: 1_900_000,
  },
  components: [
    {
      id: 'server',
      name: 'Seti server',
      state: 'up',
      pid: 4100,
      processes: 1,
      rss_bytes: 190 * MB,
      cpu_percent: 3,
      uptime_s: 1922,
      detail: { label: 'heap', bytes: 80 * MB },
    },
    {
      id: 'ea',
      name: 'EA service',
      state: 'down',
      pid: null,
      processes: 0,
      rss_bytes: 0,
      cpu_percent: null,
      uptime_s: null,
      detail: null,
    },
    {
      id: 'postgres',
      name: 'PostgreSQL',
      state: 'up',
      pid: 900,
      processes: 12,
      rss_bytes: 240 * MB,
      cpu_percent: 2,
      uptime_s: 42_000,
      detail: { label: 'database', bytes: 45 * MB },
    },
    {
      id: 'redis',
      name: 'Redis',
      state: 'up',
      pid: 910,
      processes: 1,
      rss_bytes: 12 * MB,
      cpu_percent: 0,
      uptime_s: 35_000,
      detail: { label: 'used_memory', bytes: 4 * MB },
    },
    {
      id: 'cloudflared',
      name: 'cloudflared',
      state: 'off',
      pid: null,
      processes: 0,
      rss_bytes: 0,
      cpu_percent: null,
      uptime_s: null,
      detail: null,
    },
  ],
  tasks: [
    task({
      pid: 5001,
      task: { ...HUNG_TASK, status: 'running', sandboxed: true },
      rss_bytes: 2.5 * GB,
      swap_bytes: 400 * MB,
      cpu_percent: 71,
      age_s: 540,
      tool: { name: 'Bash', command: 'git status --short', age_s: 250 },
      children: [{ pid: 5101, name: 'node', rss_bytes: 60 * MB, cpu_percent: 0, age_s: 530 }],
      flags: ['hang', 'task_memory'],
    }),
    task({
      pid: 5002,
      task: { ...QUIET_TASK, status: 'running', sandboxed: false },
      tool: { name: 'Bash', command: 'pnpm test', age_s: 20 },
      children: [{ pid: 5201, name: 'zsh', rss_bytes: 5 * MB, cpu_percent: 1, age_s: 20 }],
    }),
  ],
  totals: { processes: 4, rss_bytes: 2.87 * GB, swap_bytes: 400 * MB, cpu_percent: 73 },
  anomalies: [
    {
      rule: 'hang',
      severity: 'critical',
      message: `${HUNG_TASK.title}: 71% CPU for 4 min in Bash with no child process`,
      task_id: HUNG_TASK.id,
      component: null,
      mount: null,
    },
    {
      rule: 'task_memory',
      severity: 'warning',
      message: `${HUNG_TASK.title}: 2.5 GB RSS`,
      task_id: HUNG_TASK.id,
      component: null,
      mount: null,
    },
    {
      rule: 'swap',
      severity: 'warning',
      message: 'Swap 7.8 GB of 8.0 GB used',
      task_id: null,
      component: null,
      mount: null,
    },
    { rule: 'load', severity: 'warning', message: 'Load 17.2 on 8 CPUs', task_id: null, component: null, mount: null },
    { rule: 'down', severity: 'warning', message: 'EA service is down', task_id: null, component: 'ea', mount: null },
  ],
  history,
  sampler: { wall_ms: 6.2, cpu_ms: 5.1 },
}

const SUMMARY: ResourceSummary = {
  sampled_at: RESOURCES.sampled_at,
  memory_percent: 73,
  cpu_percent: 91,
  anomalies: RESOURCES.anomalies.length,
  severity: 'critical',
  headline: RESOURCES.anomalies[0]?.message ?? null,
}

const envelope = <T>(data: T): Envelope<T> => ({ data, meta: {} })

/** Serves the mocked sample and summary, and records the stop requests the page sends. */
export async function mockResources(page: Page): Promise<string[]> {
  const stopped: string[] = []
  await page.route('**/api/resources', async (route) => route.fulfill({ json: envelope(RESOURCES) }))
  await page.route('**/api/resources/summary', async (route) => route.fulfill({ json: envelope(SUMMARY) }))
  await page.route('**/api/tasks/*/stop', async (route) => {
    stopped.push(new URL(route.request().url()).pathname)
    await route.fulfill({ json: envelope({ ok: true }) })
  })
  return stopped
}
