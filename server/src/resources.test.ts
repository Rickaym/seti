import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { resourcesSchema, resourceSummarySchema } from '@seti/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from './app.js'
import { tasks } from './db.js'
import { Proc, type ProcStat } from './proc.js'
import { descendants } from './process-scan.js'
import { claudeProcesses, ResourceSampler } from './resources.js'
import { USER_AUTH } from './test-auth.js'
import { trackToolCalls } from './tool-calls.js'

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0)
const UPTIME_S = 100_000
const BOOT_S = T0 / 1000 - UPTIME_S
const SERVER = 100
const TASK_PROC = 200
const EA_INODE = '555001'

const stat = (pid: number, comm: string, ppid: number, startTicks = 0): ProcStat => ({
  pid,
  comm,
  state: 'S',
  ppid,
  flags: 0,
  cpuTicks: 0,
  threads: 1,
  startTicks,
})

describe('process tree and task mapping', () => {
  const tree = new Map<number, ProcStat[]>([
    [SERVER, [stat(TASK_PROC, 'claude', SERVER), stat(201, 'claude', SERVER), stat(202, 'gh', SERVER)]],
    [TASK_PROC, [stat(300, 'node', TASK_PROC), stat(301, 'zsh', TASK_PROC)]],
    [301, [stat(302, 'sleep', 301)]],
  ])

  it('walks every descendant, parents first', () => {
    expect(descendants(tree, TASK_PROC).map((s) => s.pid)).toEqual([300, 301, 302])
    expect(descendants(tree, 302)).toEqual([])
  })

  it('maps Claude Code children to the task their environment names and skips other children', () => {
    const env = new Map([[TASK_PROC, 'task-a']])
    const found = claudeProcesses(tree.get(SERVER) ?? [], (s) => env.get(s.pid) ?? null)
    expect(found.map(({ stat: s, taskId }) => [s.pid, taskId])).toEqual([
      [TASK_PROC, 'task-a'],
      [201, null],
    ])
  })
})

/** A /proc tree on disk with the processes the sampler looks for. */
class FixtureProc {
  readonly root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-proc-'))

  constructor() {
    this.write('stat', `cpu  1000 0 1000 8000 0 0 0 0 0 0\nbtime ${String(BOOT_S)}\n`)
    this.write('meminfo', 'MemTotal: 1000000 kB\nMemAvailable: 400000 kB\nSwapTotal: 100000 kB\nSwapFree: 5000 kB\n')
    this.write('self/mounts', '/dev/root / ext4 rw 0 0\n')
    this.write('net/tcp', `  sl local rem st\n   0: 0100007F:0BBF 00000000:0000 0A 0 0 0 1000 0 ${EA_INODE} 1\n`)
  }

  write(file: string, text: string): void {
    fs.mkdirSync(path.dirname(path.join(this.root, file)), { recursive: true })
    fs.writeFileSync(path.join(this.root, file), text)
  }

  /** Writes a process; `ageS` is how long before T0 it started. */
  process(
    pid: number,
    comm: string,
    ppid: number,
    opts: { ageS: number; ticks?: number; rssKb?: number; env?: string },
  ) {
    const fields = Array.from({ length: 50 }, () => '0')
    fields[0] = 'S'
    fields[1] = String(ppid)
    fields[11] = String(opts.ticks ?? 0)
    fields[17] = '4'
    fields[19] = String((UPTIME_S - opts.ageS) * 100)
    this.write(`${String(pid)}/stat`, `${String(pid)} (${comm}) ${fields.join(' ')}`)
    const rss = opts.rssKb ?? 1000
    this.write(
      `${String(pid)}/status`,
      `VmRSS:\t${String(rss)} kB\nRssAnon:\t${String(rss)} kB\nVmSwap:\t64 kB\nThreads:\t4\n`,
    )
    this.write(`${String(pid)}/environ`, opts.env ?? 'HOME=/home/me\0')
  }

  remove(): void {
    fs.rmSync(this.root, { recursive: true, force: true })
  }
}

const bashCall = (command: string): SDKMessage =>
  ({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `tool-${randomUUID()}`, name: 'Bash', input: { command } }] },
    parent_tool_use_id: null,
  }) as unknown as SDKMessage

describe('the sampler on a fixture /proc', () => {
  let fixture: FixtureProc
  let taskId: string

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    fixture = new FixtureProc()
    taskId = randomUUID()
    await tasks.insert({
      id: taskId,
      title: 'Spinning task',
      repo_id: null,
      cwd: '/tmp',
      worktree: false,
      sandbox: true,
      pr_urls: [],
    })
    fixture.process(SERVER, 'node', 1, { ageS: 7200 })
    fixture.process(201, 'claude', SERVER, { ageS: 30, rssKb: 200_000 })
    fixture.process(202, 'gh', SERVER, { ageS: 1 })
    fixture.process(300, 'node', TASK_PROC, { ageS: 3000, rssKb: 50_000 })
    fixture.process(400, 'python3', 1, { ageS: 600 })
    fs.mkdirSync(path.join(fixture.root, '400/fd'))
    fs.symlinkSync(`socket:[${EA_INODE}]`, path.join(fixture.root, '400/fd/3'))
    fixture.process(500, 'cloudflared', 1, { ageS: 900 })
  })

  afterEach(() => {
    vi.useRealTimers()
    fixture.remove()
  })

  const spin = (ticks: number, rssKb = 2_500_000) => {
    fixture.process(TASK_PROC, 'claude', SERVER, { ageS: 3600, ticks, rssKb, env: `A=1\0SETI_TASK_ID=${taskId}\0` })
  }

  async function sampleEvery10s(sampler: ResourceSampler, count: number, ticksPerSample: number) {
    let result = await sampler.sample()
    for (let i = 1; i <= count; i++) {
      vi.setSystemTime(Date.now() + 10_000)
      spin(i * ticksPerSample)
      result = await sampler.sample()
    }
    return result
  }

  it('maps processes to tasks and measures CPU over the interval, not the lifetime', async () => {
    spin(0)
    const sampler = new ResourceSampler(new Proc(fixture.root), SERVER)
    const first = await sampler.sample()
    expect(first.tasks.map((t) => [t.pid, t.task?.title ?? null, t.cpu_percent])).toEqual([
      [TASK_PROC, 'Spinning task', null],
      [201, null, null],
    ])
    vi.setSystemTime(T0 + 10_000)
    spin(350)
    const second = await sampler.sample()
    const row = second.tasks[0]
    expect(row).toMatchObject({
      pid: TASK_PROC,
      task: { id: taskId, status: 'idle', sandboxed: true },
      rss_bytes: 2_500_000 * 1024,
      cpu_percent: 35,
      threads: 4,
      age_s: 3610,
      children: [{ pid: 300, name: 'node', rss_bytes: 50_000 * 1024 }],
      flags: ['task_memory'],
    })
    expect(second.host).toMatchObject({ memory: { used_bytes: 600_000 * 1024 }, swap: { used_bytes: 95_000 * 1024 } })
    expect(second.totals).toMatchObject({ processes: 3, rss_bytes: (2_500_000 + 50_000 + 200_000) * 1024 })
    expect(second.history).toHaveLength(2)
  })

  it('flags a Bash call that spins with no child process, and clears it once a child runs', async () => {
    spin(0)
    trackToolCalls(taskId, bashCall('git status'), T0)
    const sampler = new ResourceSampler(new Proc(fixture.root), SERVER)
    const hung = await sampleEvery10s(sampler, 7, 700)
    expect(hung.tasks[0]).toMatchObject({ tool: { name: 'Bash', command: 'git status', age_s: 70 } })
    expect(hung.tasks[0]?.flags).toContain('hang')
    expect(hung.anomalies[0]).toMatchObject({ rule: 'hang', severity: 'critical', task_id: taskId })

    fixture.process(301, 'zsh', TASK_PROC, { ageS: -60 })
    vi.setSystemTime(Date.now() + 10_000)
    spin(8 * 700)
    const running = await sampler.sample()
    expect(running.tasks[0]?.flags).not.toContain('hang')
    expect(running.tasks[0]?.children.map((c) => c.name)).toEqual(['node', 'zsh'])
    trackToolCalls(taskId, { type: 'result' } as unknown as SDKMessage)
  })

  it('finds the EA by its listening socket and reports the other components', async () => {
    spin(0)
    const sampler = new ResourceSampler(new Proc(fixture.root), SERVER)
    const { components } = await sampler.sample()
    const byId = new Map(components.map((c) => [c.id, c]))
    expect(byId.get('ea')).toMatchObject({ state: 'up', pid: 400, uptime_s: 600 })
    expect(byId.get('cloudflared')).toMatchObject({ state: 'up', pid: 500 })
    expect(byId.get('server')).toMatchObject({ state: 'up', pid: SERVER, processes: 1 })
    expect(byId.get('postgres')).toMatchObject({ state: 'up', detail: { label: 'database' } })
    expect(byId.get('redis')).toMatchObject({ state: 'off' })
  })
})

describe('GET /api/resources', () => {
  const app = createApp()
  const get = async (url: string) => app.request(url, { headers: { host: '127.0.0.1:3006', ...USER_AUTH } })

  it('answers the shape the UI reads, from the real /proc', async () => {
    const res = await get('/api/resources')
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: unknown }
    const resources = resourcesSchema.parse(data)
    expect(resources.host.cpus).toBeGreaterThan(0)
    expect(resources.components.map((c) => c.id)).toEqual(['server', 'ea', 'postgres', 'redis', 'cloudflared'])
    expect(resources.components[0]).toMatchObject({ state: 'up', pid: process.pid })
    expect(JSON.stringify(data)).not.toMatch(/SETI_TASK_ID|--settings/)
  })

  it('answers a summary for the status bar', async () => {
    const res = await get('/api/resources/summary')
    const { data } = (await res.json()) as { data: unknown }
    const summary = resourceSummarySchema.parse(data)
    expect(summary.memory_percent).toBeGreaterThan(0)
  })
})
