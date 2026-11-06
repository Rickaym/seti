import type { ComponentResources, HostResources } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import {
  DISK_FULL_PERCENT,
  evaluateRules,
  HANG_AFTER_MS,
  HANG_CPU_PERCENT,
  HOST_MEMORY_PERCENT,
  isHung,
  LOAD_PER_CPU,
  SWAP_FULL_PERCENT,
  sustainedMs,
  TASK_MEMORY_BYTES,
  type CpuPoint,
  type TaskCandidate,
} from './resource-rules.js'

const GB = 1024 ** 3
const NOW = 1_800_000_000_000

const host = (over: Partial<HostResources> = {}): HostResources => ({
  cpus: 8,
  load: [1, 1, 1],
  cpu_percent: 20,
  memory: { total_bytes: 32 * GB, used_bytes: 8 * GB, available_bytes: 24 * GB },
  swap: { total_bytes: 8 * GB, used_bytes: 0 },
  disks: [
    {
      mount: '/',
      holds: ['Seti home'],
      total_bytes: 100 * GB,
      used_bytes: 50 * GB,
      free_bytes: 50 * GB,
      used_percent: 50,
    },
  ],
  uptime_s: 1000,
  ...over,
})

const component = (over: Partial<ComponentResources>): ComponentResources => ({
  id: 'ea',
  name: 'EA service',
  state: 'up',
  pid: 10,
  processes: 1,
  rss_bytes: 0,
  cpu_percent: 0,
  uptime_s: 10,
  detail: null,
  ...over,
})

const busy = (percent: number, count: number): CpuPoint[] =>
  Array.from({ length: count }, () => ({ percent, spanMs: 10_000 }))

const task = (over: Partial<TaskCandidate> = {}): TaskCandidate => ({
  taskId: 't1',
  label: 'Fix the build',
  rssBytes: 300 * 1024 ** 2,
  cpu: busy(70, 7),
  tool: { name: 'Bash', since: NOW - 90_000 },
  childStarts: [],
  ...over,
})

describe('sustained CPU', () => {
  it('adds up the newest readings back to the first dip', () => {
    expect(sustainedMs([...busy(90, 2), { percent: 10, spanMs: 10_000 }, ...busy(60, 3)], 50)).toBe(30_000)
    expect(sustainedMs(busy(90, 6), 50)).toBe(60_000)
    expect(sustainedMs([...busy(90, 6), { percent: 49, spanMs: 10_000 }], 50)).toBe(0)
    expect(sustainedMs([], 50)).toBe(0)
  })
})

describe('the hang rule', () => {
  it('flags a busy tool call past a minute with no child process', () => {
    expect(isHung(task(), NOW)).toBe(true)
  })

  it('leaves a tool call alone while it runs a child it started', () => {
    expect(isHung(task({ childStarts: [NOW - 85_000] }), NOW)).toBe(false)
  })

  it('does not count a child older than the tool call, such as an MCP server', () => {
    expect(isHung(task({ childStarts: [NOW - 3_600_000] }), NOW)).toBe(true)
  })

  it('waits a minute into the tool call', () => {
    expect(isHung(task({ tool: { name: 'Bash', since: NOW - HANG_AFTER_MS + 1000 } }), NOW)).toBe(false)
  })

  it('needs the CPU to stay high for a minute', () => {
    expect(isHung(task({ cpu: busy(HANG_CPU_PERCENT + 20, 5) }), NOW)).toBe(false)
    expect(isHung(task({ cpu: [...busy(90, 6), { percent: HANG_CPU_PERCENT - 1, spanMs: 10_000 }] }), NOW)).toBe(false)
  })

  it('ignores a process with no tool call open', () => {
    expect(isHung(task({ tool: null }), NOW)).toBe(false)
  })

  it('reports the hang as critical with the tool, the CPU and how long', () => {
    const { anomalies, flags } = evaluateRules({ now: NOW, host: host(), components: [], tasks: [task()] })
    expect(flags).toEqual([['hang']])
    expect(anomalies).toEqual([
      {
        rule: 'hang',
        severity: 'critical',
        message: 'Fix the build: 70% CPU for 70 s in Bash with no child process',
        task_id: 't1',
        component: null,
        mount: null,
      },
    ])
  })
})

describe('memory, swap, disk, load and component rules', () => {
  it('flags a task process above the memory threshold', () => {
    const { anomalies, flags } = evaluateRules({
      now: NOW,
      host: host(),
      components: [],
      tasks: [task({ tool: null }), task({ taskId: 't2', label: 'Big', tool: null, rssBytes: TASK_MEMORY_BYTES + 1 })],
    })
    expect(flags).toEqual([[], ['task_memory']])
    expect(anomalies).toMatchObject([
      { rule: 'task_memory', severity: 'warning', task_id: 't2', message: 'Big: 1.5 GB RSS' },
    ])
  })

  it('flags host memory, a nearly full swap, a full disk and a high load', () => {
    const { anomalies } = evaluateRules({
      now: NOW,
      host: host({
        load: [LOAD_PER_CPU * 8 + 1, 10, 9],
        memory: { total_bytes: 100 * GB, used_bytes: HOST_MEMORY_PERCENT * GB, available_bytes: 10 * GB },
        swap: { total_bytes: 10 * GB, used_bytes: (SWAP_FULL_PERCENT / 10) * GB },
        disks: [
          {
            mount: '/',
            holds: ['Seti home'],
            total_bytes: 100 * GB,
            used_bytes: 95 * GB,
            free_bytes: 5 * GB,
            used_percent: 95,
          },
          {
            mount: '/data',
            holds: ['Postgres data'],
            total_bytes: 100 * GB,
            used_bytes: 10 * GB,
            free_bytes: 90 * GB,
            used_percent: DISK_FULL_PERCENT - 1,
          },
        ],
      }),
      components: [],
      tasks: [],
    })
    expect(anomalies.map((a) => [a.rule, a.message])).toEqual([
      ['host_memory', 'Memory 90% used'],
      ['swap', 'Swap 9.0 GB of 10.0 GB used'],
      ['disk', 'Disk / 95% full, 5.0 GB free'],
      ['load', 'Load 17.0 on 8 CPUs'],
    ])
  })

  it('leaves a host with no swap alone', () => {
    const { anomalies } = evaluateRules({
      now: NOW,
      host: host({ swap: { total_bytes: 0, used_bytes: 0 } }),
      components: [],
      tasks: [],
    })
    expect(anomalies).toEqual([])
  })

  it('flags a component that is down but not one that is off', () => {
    const { anomalies } = evaluateRules({
      now: NOW,
      host: host(),
      components: [component({ state: 'down', pid: null }), component({ id: 'redis', name: 'Redis', state: 'off' })],
      tasks: [],
    })
    expect(anomalies).toEqual([
      { rule: 'down', severity: 'warning', message: 'EA service is down', task_id: null, component: 'ea', mount: null },
    ])
  })

  it('puts critical anomalies first', () => {
    const { anomalies } = evaluateRules({
      now: NOW,
      host: host(),
      components: [component({ state: 'down' })],
      tasks: [task()],
    })
    expect(anomalies.map((a) => a.severity)).toEqual(['critical', 'warning'])
  })
})
