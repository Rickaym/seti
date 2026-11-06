import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_CAP_DEFAULTS, memoryBudgetLine, memoryNote, type OomVictims } from '@seti/shared'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { parseOomKills, processLabel, TOOL_OOM_ADJ, ToolGuard } from './oom-guard.js'
import { Proc } from './proc.js'

describe('processLabel', () => {
  it('names a Node, Python or npm tool by its script, not its interpreter', () => {
    expect(processLabel('MainThread', ['node', '/w/node_modules/typescript/bin/tsc', '--noEmit'])).toBe('tsc')
    expect(processLabel('node', ['/usr/bin/node', '--max-old-space-size=8192', 'node_modules/.bin/eslint', '.'])).toBe(
      'eslint',
    )
    expect(processLabel('npm exec tsc', ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'exec', 'tsc'])).toBe(
      'npm',
    )
    expect(processLabel('prettier', ['node', '/w/node_modules/prettier/bin/prettier.cjs', '--check'])).toBe('prettier')
    expect(processLabel('python3', ['python3', '-m', 'pytest'])).toBe('pytest')
  })

  it('names any other program by its file, and falls back to the kernel name', () => {
    expect(processLabel('chrome-headless', ['/opt/chrome/chrome-headless-shell', '--headless'])).toBe(
      'chrome-headless-shell',
    )
    expect(processLabel('node', ['node', '-e', 'let a = []'])).toBe('node')
    expect(processLabel('cc1plus', [])).toBe('cc1plus')
  })
})

describe('parseOomKills', () => {
  const unit = 'seti-08186cdf-agent-2ed9222b-c8978628.scope'
  const memcg = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`
  const line = (task: string, pid: number, scope = memcg) =>
    `oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=user.slice,mems_allowed=0,` +
    `oom_memcg=${scope},task_memcg=${scope},task=${task},pid=${String(pid)},uid=1000`

  it("reads the victims of the unit's kills in order and skips other scopes", () => {
    const log = [
      'MainThread invoked oom-killer: gfp_mask=0xcc0(GFP_KERNEL), order=0, oom_score_adj=200',
      line('MainThread', 1161864),
      'Memory cgroup out of memory: Killed process 1161864 (MainThread) total-vm:7052296kB',
      line('claude', 151950),
      line('node', 42, '/user.slice/user-1000.slice/user@1000.service/app.slice/other.scope'),
    ].join('\n')
    expect(parseOomKills(log, unit)).toEqual([
      { pid: 1161864, comm: 'MainThread' },
      { pid: 151950, comm: 'claude' },
    ])
    expect(parseOomKills('', unit)).toEqual([])
  })
})

describe('ToolGuard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-oom-guard-'))
  const proc = new Proc(root)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true })
    }
  })

  const PF_FORKNOEXEC = 0x40

  function writeStat(pid: number, comm: string, ppid: number, flags: number) {
    const fields = ['S', ppid, pid, pid, 0, -1, flags, 0, 0, 0, 0, 30, 20, 0, 0, 20, 0, 1, 0, 5000]
    fs.mkdirSync(path.join(root, String(pid)), { recursive: true })
    fs.writeFileSync(path.join(root, String(pid), 'stat'), `${String(pid)} (${comm}) ${fields.join(' ')}`)
  }

  /** The process now runs `argv`; an empty one is how /proc shows it in the middle of its exec. */
  function exec(pid: number, comm: string, ppid: number, argv: string[]) {
    writeStat(pid, comm, ppid, 0)
    fs.writeFileSync(path.join(root, String(pid), 'cmdline'), argv.length === 0 ? '' : `${argv.join('\0')}\0`)
  }

  function fixture(pid: number, comm: string, ppid: number, argv: string[]) {
    exec(pid, comm, ppid, argv)
    fs.writeFileSync(path.join(root, String(pid), 'oom_score_adj'), '200')
  }

  /** A child of `ppid` before its exec: the parent's name and command line, and its adj. */
  function fork(pid: number, ppid: number) {
    const parent = path.join(root, String(ppid))
    const stat = fs.readFileSync(path.join(parent, 'stat'), 'utf8')
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'))
    writeStat(pid, comm, ppid, PF_FORKNOEXEC)
    for (const file of ['cmdline', 'oom_score_adj']) {
      fs.copyFileSync(path.join(parent, file), path.join(root, String(pid), file))
    }
  }

  const adj = (pid: number) => Number(fs.readFileSync(path.join(root, String(pid), 'oom_score_adj'), 'utf8'))

  it("finds Claude Code below the sandbox's launchers and raises everything else it started", () => {
    fixture(100, 'bwrap', 1, ['bwrap', '--unshare-pid'])
    fixture(101, 'bwrap', 100, ['bwrap', '--unshare-pid'])
    fixture(102, 'claude', 101, ['/opt/claude', '--output-format'])
    fixture(103, 'socat', 102, ['socat', 'TCP-LISTEN:3128', 'UNIX-CONNECT:/run/seti/proxy.sock'])
    fixture(104, 'bash', 102, ['/bin/bash', '-c', 'tsc'])
    fixture(105, 'MainThread', 104, ['node', '/w/node_modules/typescript/bin/tsc'])
    const guard = new ToolGuard(proc, 100)
    guard.tick([100, 101, 102, 103, 104, 105])
    expect([100, 101, 102, 103].map(adj)).toEqual([200, 200, 200, 200])
    expect([104, 105].map(adj)).toEqual([TOOL_OOM_ADJ, TOOL_OOM_ADJ])
    expect(guard.isRoot(102)).toBe(true)
    expect(guard.labelOf(105, 'MainThread')).toBe('tsc')
    expect(guard.rootGone()).toBe(false)
  })

  it('waits while only launchers run, and takes the process systemd-run started when it is no launcher', () => {
    fixture(200, 'env', 1, ['env', '-u', 'XDG_RUNTIME_DIR', 'bwrap'])
    const guard = new ToolGuard(proc, 200)
    guard.tick([200])
    expect(guard.rootGone()).toBe(false)
    expect(guard.isRoot(200)).toBe(true)
    expect(adj(200)).toBe(200)

    const direct = new ToolGuard(proc, 300)
    fixture(300, 'claude', 1, ['/opt/claude'])
    fixture(301, 'zsh', 300, ['/bin/zsh', '-c', 'sleep 1'])
    direct.tick([300, 301])
    expect([adj(300), adj(301)]).toEqual([200, TOOL_OOM_ADJ])
  })

  it('raises a tool that left its parent, leaves a higher adj alone and tells when the root is gone', () => {
    fixture(400, 'claude', 1, ['/opt/claude'])
    const guard = new ToolGuard(proc, 400)
    guard.tick([400])
    fixture(401, 'node', 1, ['node', 'server.js'])
    fixture(402, 'chrome', 400, ['/opt/chrome'])
    fs.writeFileSync(path.join(root, '402', 'oom_score_adj'), '1000')
    guard.tick([400, 401, 402])
    expect([adj(400), adj(401), adj(402)]).toEqual([200, TOOL_OOM_ADJ, 1000])
    fs.rmSync(path.join(root, '400'), { recursive: true })
    expect(guard.rootGone()).toBe(true)
  })

  it("raises a fork before its exec at once, and names it by the program it runs, not its parent's", () => {
    fixture(500, 'node', 1, ['node', '/w/root.cjs'])
    fork(501, 500)
    const guard = new ToolGuard(proc, 500)
    guard.tick([500, 501])
    expect(adj(501)).toBe(TOOL_OOM_ADJ)
    expect(guard.labelOf(501, 'node')).toBeNull()
    exec(501, 'node', 500, [])
    guard.tick([500, 501])
    expect(guard.labelOf(501, 'node')).toBeNull()
    exec(501, 'node', 500, ['node', '/w/hog.cjs'])
    guard.tick([500, 501])
    expect(guard.labelOf(501, 'node')).toBe('hog')
  })

  it('names a command after the shell that ran it execs the program, and keeps the proxy bridge low', () => {
    fixture(600, 'claude', 1, ['/opt/claude'])
    fixture(601, 'tool-shell', 600, ['/bin/sh', '/run/seti/tool-shell', 'tsc'])
    fork(602, 600)
    const guard = new ToolGuard(proc, 600)
    guard.tick([600, 601, 602])
    expect(guard.labelOf(601, 'tool-shell')).toBe('sh')
    expect(guard.labelOf(601, 'MainThread')).toBeNull()
    exec(601, 'MainThread', 600, ['node', '/w/node_modules/typescript/bin/tsc'])
    exec(602, 'socat', 600, ['socat', 'TCP-LISTEN:3128', 'UNIX-CONNECT:/run/seti/proxy.sock'])
    guard.tick([600, 601, 602])
    expect(guard.labelOf(601, 'MainThread')).toBe('tsc')
    expect([adj(600), adj(601), adj(602)]).toEqual([200, TOOL_OOM_ADJ, 200])
  })
})

describe('memory notes', () => {
  const report = (victims: OomVictims | null, kind: 'agent' | 'shell' = 'agent') =>
    memoryNote({ event: 'oom_kill', cap: MEMORY_CAP_DEFAULTS, kind, victims })

  it('names the tools the cap stopped, so the note shows the agent went on', () => {
    expect(report({ root: false, names: ['tsc'] })).toBe(
      "tsc was stopped: the agent's process tree hit its 6 GB memory cap",
    )
    expect(report({ root: false, names: ['tsc', 'eslint', 'tsc', 'chrome-headless-shell'] })).toBe(
      "tsc, eslint and chrome-headless-shell were stopped: the agent's process tree hit its 6 GB memory cap",
    )
  })

  it('says the turn ended when the cap stopped Claude Code itself', () => {
    expect(report({ root: true, names: [] })).toBe(
      'Claude Code was stopped: its process tree hit its 6 GB memory cap; the turn ended',
    )
    expect(report({ root: true, names: ['tsc'] })).toBe(
      "Claude Code and tsc were stopped: the agent's process tree hit its 6 GB memory cap; the turn ended",
    )
  })

  it('stays generic when Seti could not tell what stopped, and covers shell commands', () => {
    expect(report(null)).toBe("A process was stopped: the agent's process tree hit its 6 GB memory cap")
    expect(report({ root: false, names: [] })).toBe(report(null))
    expect(report({ root: true, names: [] }, 'shell')).toBe(
      'The shell command was stopped: its process tree hit its 6 GB memory cap',
    )
    expect(
      memoryNote({ event: 'high', cap: { high_mb: 1536, max_mb: 2048, swap_max_mb: 0 }, kind: 'agent', victims: null }),
    ).toContain('1.5 GB')
  })

  it('gives the agent its budget in one line of its system prompt', () => {
    expect(memoryBudgetLine(MEMORY_CAP_DEFAULTS, 4300)).toBe(
      'Your process tree has a 6 GB memory cap. Keep Node heaps (--max-old-space-size) under about 4.2 GB, ' +
        'run one tsc or build at a time, and prefer incremental or per-package type checks. At the cap the ' +
        'kernel stops your largest tool process first.',
    )
  })
})
