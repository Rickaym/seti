import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MEMORY_CAP_DEFAULTS } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { messages, tasks } from './db.js'
import { recordMemoryEvents } from './memory-notes.js'
import {
  capProperties,
  detectScopeHost,
  launch,
  ownUnit,
  parseEvents,
  scopeArgs,
  unitName,
  type ScopeHost,
} from './memory-scope.js'
import { oomRun, oomScriptArgs } from './oom-fixtures.js'
import { TOOL_OOM_ADJ } from './oom-guard.js'
import { applyCaps, scopeMemory } from './scope-limits.js'
import { agentEnv } from './session-options.js'

describe('scope arguments', () => {
  it('holds the scope to the cap, keeps the rest of the tree on an OOM kill and stops after Seti', () => {
    const args = scopeArgs(
      { unit: 'seti-x-agent-t-1.scope', cap: MEMORY_CAP_DEFAULTS, cpu: null, bindTo: 'seti.service' },
      '/usr/bin/bwrap',
      ['--die-with-parent', '--', 'claude', '--print'],
    )
    expect(args).toEqual([
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      '--unit=seti-x-agent-t-1.scope',
      '-p',
      'MemoryHigh=infinity',
      '-p',
      'MemoryMax=6144M',
      '-p',
      'MemorySwapMax=1024M',
      '-p',
      'OOMPolicy=continue',
      '-p',
      'TimeoutStopSec=10s',
      '-p',
      'BindsTo=seti.service',
      '-p',
      'StopPropagatedFrom=seti.service',
      '-p',
      'Before=seti.service',
      '--',
      '/usr/bin/bwrap',
      '--die-with-parent',
      '--',
      'claude',
      '--print',
    ])
  })

  it('binds to nothing outside a unit, and throttles only below the cap', () => {
    const cap = { high_mb: 512, max_mb: 512, swap_max_mb: 0 }
    expect(capProperties(cap)).toEqual(['MemoryHigh=infinity', 'MemoryMax=512M', 'MemorySwapMax=0M'])
    expect(capProperties({ ...cap, high_mb: 384 })[0]).toBe('MemoryHigh=384M')
    const args = scopeArgs({ unit: 'u.scope', cap, cpu: null, bindTo: null }, 'true', [])
    expect(args.some((arg) => /^(BindsTo|StopPropagatedFrom|Before)=/.test(arg))).toBe(false)
    expect(args.slice(-2)).toEqual(['--', 'true'])
  })

  it('finds the unit Seti runs in under the user manager, and none elsewhere', () => {
    const service = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/seti.service\n'
    expect(ownUnit(service, 1000)).toBe('seti.service')
    expect(ownUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope', 1000)).toBe(
      'tmux-spawn-1.scope',
    )
    expect(ownUnit(service, 1001)).toBeNull()
    expect(ownUnit('0::/system.slice/actions.runner.service\n', 1000)).toBeNull()
    expect(ownUnit('0::/user.slice/user-1000.slice/user@1000.service/app.slice\n', 1000)).toBeNull()
    expect(ownUnit('', 1000)).toBeNull()
  })

  it('names each scope apart, with only characters a unit name takes', () => {
    const first = unitName('task/with odd:chars', 'shell')
    expect(first).toMatch(/^seti-[0-9a-f]{8}-shell-task_with_odd_chars-[0-9a-f]{8}\.scope$/)
    expect(unitName('task/with odd:chars', 'shell')).not.toBe(first)
  })

  it('reads the OOM kill and throttle counters of memory.events', () => {
    const text = 'low 0\nhigh 6466\nmax 35\noom 1\noom_kill 2\noom_group_kill 0\n'
    expect(parseEvents(text)).toEqual({ oom_kill: 2, high: 6466 })
    expect(parseEvents('')).toEqual({ oom_kill: 0, high: 0 })
  })

  it('starts the command as it is without a plan, and reports no scope memory', () => {
    const start = vi.fn(() => spawn(process.execPath, ['-e', '']))
    launch(null, '/bin/bash', ['-lc', 'echo'], start)
    expect(start).toHaveBeenCalledWith('/bin/bash', ['-lc', 'echo'])
    expect(scopeMemory('no-such-task')).toEqual([])
  })
})

const host = await detectScopeHost(true)
const NO_CPU_CAP = { quota_percent: null }

/** Allocates 256 MB a megabyte at a time, far past the 64 MB cap the test gives it. */
const ALLOCATE = 'const a = []; for (let i = 0; i < 256; i++) a.push(Buffer.alloc(1 << 20, 1))'

describe.skipIf(host === null)('a scope on this host', () => {
  it('stops a process over its cap inside the scope and notes it in the transcript', async ({ skip }) => {
    if (host === null) {
      skip()
      return
    }
    const taskId = 'memory-scope-oom'
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-memory-scope-'))
    await tasks.insert({ id: taskId, title: 'Memory', repo_id: null, cwd, worktree: false, pr_urls: [] })
    recordMemoryEvents()
    const cap = { high_mb: 64, max_mb: 64, swap_max_mb: 0 }
    const child = launch(
      { host, taskId, kind: 'shell', cap, cpu: NO_CPU_CAP },
      process.execPath,
      ['-e', ALLOCATE],
      (command, args) =>
        spawn(command, args, { env: { ...process.env, XDG_RUNTIME_DIR: host.runtimeDir }, stdio: 'ignore' }),
    )
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null]
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGKILL' })
    await vi.waitFor(
      async () => {
        const notes = (await messages.page(taskId, 10)).messages.filter((row) => row.kind === 'seti')
        expect(notes.map((row) => row.payload)).toEqual([
          { error: 'The shell command was stopped: its process tree hit its 64 MB memory cap', memory: 'oom_kill' },
        ])
      },
      { timeout: 5000 },
    )
    expect(scopeMemory(taskId)).toEqual([])
  })

  /** Runs the Claude Code stand-in in a 300 MB agent scope until its tool is stopped. */
  async function overCap(scopes: ScopeHost, taskId: string, tool: 'hog' | 'rush') {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-oom-guard-'))
    await tasks.insert({ id: taskId, title: 'Guard', repo_id: null, cwd, worktree: false, pr_urls: [] })
    recordMemoryEvents()
    const cap = { high_mb: 300, max_mb: 300, swap_max_mb: 0 }
    let out = ''
    const child = launch(
      { host: scopes, taskId, kind: 'agent', cap, cpu: NO_CPU_CAP },
      process.execPath,
      oomScriptArgs(cwd, tool),
      (command, args) => {
        const started = spawn(command, args, {
          env: { ...agentEnv(cap), XDG_RUNTIME_DIR: scopes.runtimeDir },
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        started.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()))
        return started
      },
    )
    const [code, signal] = (await once(child, 'exit')) as [number | null, string | null]
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    const result = oomRun(out)
    expect(result).toMatchObject({ held: 160, oomGroup: '0', after: result.before })
    expect(Number(result.before)).toBeLessThan(TOOL_OOM_ADJ)
    expect(result.child).toEqual({ code: null, signal: 'SIGKILL', adj: String(TOOL_OOM_ADJ) })
    const notes = async () =>
      (await messages.page(taskId, 10)).messages.flatMap((row) => (row.kind === 'seti' ? [row.payload] : []))
    await vi.waitFor(
      async () => {
        expect(await notes()).toHaveLength(1)
      },
      { timeout: 5000 },
    )
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const [note, ...more] = await notes()
    expect(more).toEqual([])
    expect(note).toMatchObject({ memory: 'oom_kill' })
    expect(note?.ended_turn).toBeUndefined()
    fs.rmSync(cwd, { recursive: true, force: true })
    return note?.error
  }

  const limit = "the agent's process tree hit its 300 MB memory cap"

  it('stops a tool the guard raised, not the larger process the scope started, and notes it once', async ({ skip }) => {
    if (host === null) {
      skip()
      return
    }
    expect([`hog was stopped: ${limit}`, `A process was stopped: ${limit}`]).toContain(
      await overCap(host, 'memory-scope-guard', 'hog'),
    )
  })

  it('starts a command at the raised adj, so one filling the cap at once is stopped, not the root', async ({
    skip,
  }) => {
    if (host === null) {
      skip()
      return
    }
    const named = ['rush', 'MainThread', 'node', 'A process'].map((name) => `${name} was stopped: ${limit}`)
    expect(named).toContain(await overCap(host, 'memory-scope-rush', 'rush'))
  })

  it('moves a running scope to a new cap with no session bus in its environment', async ({ skip }) => {
    if (host === null) {
      skip()
      return
    }
    const taskId = 'memory-scope-apply'
    const cap = { high_mb: 512, max_mb: 512, swap_max_mb: 0 }
    const child = launch(
      { host, taskId, kind: 'shell', cap, cpu: NO_CPU_CAP },
      process.execPath,
      ['-e', 'setTimeout(() => {}, 30000)'],
      (command, args) =>
        spawn(command, args, { env: { ...process.env, XDG_RUNTIME_DIR: host.runtimeDir }, stdio: 'ignore' }),
    )
    const bus = { runtime: process.env.XDG_RUNTIME_DIR, dbus: process.env.DBUS_SESSION_BUS_ADDRESS }
    try {
      await vi.waitFor(() => {
        expect(scopeMemory(taskId)).toHaveLength(1)
      })
      delete process.env.XDG_RUNTIME_DIR
      delete process.env.DBUS_SESSION_BUS_ADDRESS
      const next = { high_mb: 768, max_mb: 768, swap_max_mb: 0 }
      await applyCaps(async (id) => Promise.resolve(id === taskId ? next : null))
      expect(scopeMemory(taskId)[0]?.max_bytes).toBe(768 * 1024 * 1024)
    } finally {
      if (bus.runtime !== undefined) {
        process.env.XDG_RUNTIME_DIR = bus.runtime
      }
      if (bus.dbus !== undefined) {
        process.env.DBUS_SESSION_BUS_ADDRESS = bus.dbus
      }
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })
})
