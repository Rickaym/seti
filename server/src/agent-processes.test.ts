import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProcesses } from '@seti/shared'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { readProcesses, shellOutput, stoppable, subtreeOf, terminate } from './agent-processes.js'
import { forgetShells } from './background-shells.js'
import { messages, tasks } from './db.js'
import { Proc } from './proc.js'
import { backgroundResult, shellCall, shellStarted } from './shell-fixtures.js'

const TASK = 'processes-task'
const OTHER = 'processes-other'
const host = { proc: new Proc(), serverPid: process.pid }
const spawned: ChildProcess[] = []

/** A stand-in for Claude Code: a child of this process that names the task in its environment. */
function agent(script: string, taskId = TASK): ChildProcess {
  const child = spawn('/bin/bash', ['-c', script], { env: { ...process.env, SETI_TASK_ID: taskId }, stdio: 'ignore' })
  spawned.push(child)
  return child
}

const alive = (pid: number) => {
  const stat = host.proc.stat(pid)
  return stat !== null && stat.state !== 'Z'
}

/** The task's tree once exactly these process names run in it, every fork past its exec. */
async function treeOf(...names: string[]): Promise<AgentProcesses> {
  const byName = (a: string, b: string) => a.localeCompare(b)
  return vi.waitFor(async () => {
    const { view } = await readProcesses(TASK, null, host)
    expect(view.processes.map((p) => p.name).toSorted(byName)).toEqual(names.toSorted(byName))
    return view
  })
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    child.kill('SIGKILL')
  }
})

describe('the process tree of a task', () => {
  it('lists the task processes with their kind, depth and usage, and none of another task', async () => {
    const root = agent('bash -c "sleep 301; true" --token=hunter2hunter2 & sleep 302 & wait')
    const other = agent('sleep 303 & wait', OTHER)
    const view = await treeOf('bash', 'bash', 'sleep', 'sleep')
    const rows = view.processes.map((p) => [p.name, p.kind, p.depth])
    expect(rows).toEqual([
      ['bash', 'agent', 0],
      ['bash', 'command', 1],
      ['sleep', 'command', 2],
      ['sleep', 'tool', 1],
    ])
    expect(view.processes.some((p) => p.pid === other.pid)).toBe(false)
    const [top, command, inner, tool] = view.processes
    expect(top?.pid).toBe(root.pid)
    expect(command?.command).toBe('bash -c sleep 301; true --token=[redacted]')
    expect(inner?.ppid).toBe(command?.pid)
    expect(tool?.command).toBe('sleep 302')
    expect(top?.rss_bytes).toBeGreaterThan(0)
    expect(top?.ns_pid).toBeNull()
    expect(view.running).toBe(1)
    expect(view.sandboxed).toBe(false)
  })

  it('refuses pids outside the tree, a reused pid, Claude Code itself and Seti helpers', async () => {
    agent('sleep 304 & wait')
    const { processes } = await treeOf('bash', 'sleep')
    const [top, sleeper] = processes
    if (top === undefined || sleeper === undefined) {
      throw new Error('tree missing')
    }
    expect(() => stoppable(processes, process.pid, 0)).toThrow('not running in this agent')
    expect(() => stoppable(processes, sleeper.pid, sleeper.start_ticks + 1)).toThrow('not running in this agent')
    expect(() => stoppable(processes, top.pid, top.start_ticks)).toThrow('Claude Code itself')
    expect(() => stoppable([{ ...sleeper, kind: 'seti' }], sleeper.pid, sleeper.start_ticks)).toThrow("Seti's own")
    expect(stoppable(processes, sleeper.pid, sleeper.start_ticks)).toBe(sleeper)
  })

  it('stops a command with everything it started, and kills what ignores SIGTERM', async () => {
    const root = agent('bash -c "sleep 305; true" & bash -c "trap \\"\\" TERM; sleep 306; true" & sleep 307 & wait')
    const { processes } = await treeOf('bash', 'bash', 'bash', 'sleep', 'sleep', 'sleep')
    const [polite, stubborn] = processes.filter((p) => p.depth === 1 && p.name === 'bash')
    if (polite === undefined || stubborn === undefined) {
      throw new Error('commands missing')
    }
    const politeTree = subtreeOf(processes, polite)
    expect(politeTree.map((p) => p.name)).toEqual(['bash', 'sleep'])
    await terminate(politeTree, host, 2000)
    expect(politeTree.some((p) => alive(p.pid))).toBe(false)

    const stubbornTree = subtreeOf(processes, stubborn)
    const started = Date.now()
    await terminate(stubbornTree, host, 300)
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    await vi.waitFor(() => {
      expect(stubbornTree.some((p) => alive(p.pid))).toBe(false)
    })
    expect(alive(root.pid ?? 0)).toBe(true)
  })
})

describe('background shells in the tree', () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seti-shells-')))

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('ties a shell to its process by its output file or its command, and reads its output', async () => {
    await tasks.insert({ id: TASK, title: 'Processes', repo_id: null, cwd: tmp, worktree: false, pr_urls: [] })
    forgetShells(TASK)
    const watch = 'while true; do sleep 0.3; done'
    const first = await messages.insert(TASK, shellCall('toolu_tick', { command: 'tick', run_in_background: true }), [])
    for (const body of [
      shellStarted({ shellId: 'btick', toolUseId: 'toolu_tick', description: 'Tick', background: true }),
      backgroundResult('toolu_tick', 'btick', tmp),
      shellCall('toolu_watch', { command: watch, description: 'Watch' }, 'Monitor'),
      shellStarted({ shellId: 'bwatch', toolUseId: 'toolu_watch', description: 'Watch', background: true }),
    ]) {
      await messages.insert(TASK, body, [])
    }
    const out = path.join(tmp, 'claude-1000', '-home-user-work-demo')
    const shells = (await readProcesses(TASK, first.id, host)).shells
    const file = shells.find((s) => s.id === 'btick')?.output_file ?? ''
    expect(file.startsWith(out)).toBe(true)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const secret = ['ghp', '_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')
    const root = agent(
      `bash -c 'echo "token ${secret}"; while true; do echo tick; sleep 0.2; done' > ${file} 2>&1 & ` +
        `bash -c '${watch}' & wait`,
    )
    let view = (await readProcesses(TASK, first.id, host)).view
    await vi.waitFor(async () => {
      view = (await readProcesses(TASK, first.id, host)).view
      expect(view.shells.map((s) => [s.id, s.pid !== null])).toEqual([
        ['btick', true],
        ['bwatch', true],
      ])
    })
    const tick = view.processes.find((p) => p.pid === view.shells[0]?.pid)
    expect(tick).toMatchObject({ kind: 'command', depth: 1, shell_id: 'btick' })
    expect(view.processes.filter((p) => p.shell_id === 'bwatch').length).toBeGreaterThan(0)
    expect(view.running).toBe(2)
    expect(root.pid).toBeDefined()

    const shell = (await readProcesses(TASK, first.id, host)).shells.find((s) => s.id === 'btick')
    if (shell === undefined) {
      throw new Error('shell missing')
    }
    await vi.waitFor(() => {
      expect(shellOutput(TASK, shell).text).toContain('tick')
    })
    const output = shellOutput(TASK, shell)
    expect(output.text).not.toContain(secret)
    expect(output.size_bytes).toBeGreaterThan(0)

    fs.rmSync(file)
    fs.symlinkSync('/etc/hostname', file)
    expect(() => shellOutput(TASK, shell)).toThrow('cannot be read')
    expect(shellOutput(TASK, { ...shell, output_file: '/etc/passwd' }).text).toBe('')
    expect(shellOutput(TASK, { ...shell, output_file: `${tmp}/claude-1000/x/../tasks/btick.output` }).text).toBe('')
  })
})

describe('a /proc without children files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-proc-'))

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  /** One fixture process: stat fields after the name start at the state, the third field. */
  interface Fixture {
    pid: number
    comm: string
    ppid: number
    state?: string
    argv: string[]
    env?: string
  }

  function fixture({ pid, comm, ppid, state = 'S', argv, env = '' }: Fixture) {
    const dir = path.join(root, String(pid))
    fs.mkdirSync(path.join(dir, 'task', String(pid)), { recursive: true })
    const fields = [state, ppid, pid, pid, 0, -1, 0, 0, 0, 0, 0, 30, 20, 0, 0, 20, 0, 1, 0, 5000]
    fs.writeFileSync(path.join(dir, 'stat'), `${String(pid)} (${comm}) ${fields.join(' ')}`)
    fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`)
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${comm}\nVmRSS:\t 2048 kB\nNSpid:\t${String(pid)}\n`)
    fs.writeFileSync(path.join(dir, 'environ'), env)
  }

  it('falls back to reading every process and still sorts out kinds', async () => {
    fs.writeFileSync(path.join(root, 'stat'), 'cpu  1 2 3 4\nbtime 1000\n')
    fixture({ pid: 1, comm: 'node', ppid: 0, argv: ['node', 'seti'] })
    fixture({
      pid: 10,
      comm: 'claude',
      ppid: 1,
      argv: ['claude', '--output-format', 'stream-json'],
      env: 'HOME=/h\0SETI_TASK_ID=fixture\0',
    })
    fixture({ pid: 11, comm: 'zsh', ppid: 10, argv: ['/usr/bin/zsh', '-c', 'npm publish --token=abcdefghijkl'] })
    fixture({
      pid: 12,
      comm: 'socat',
      ppid: 10,
      argv: ['socat', 'TCP-LISTEN:3128,fork', 'UNIX-CONNECT:/run/proxy.sock'],
    })
    fixture({ pid: 13, comm: 'npm exec mcp', ppid: 10, argv: ['npm', 'exec', 'mcp-server'] })
    fixture({ pid: 14, comm: 'zsh', ppid: 10, state: 'Z', argv: [] })
    fixture({ pid: 20, comm: 'claude', ppid: 1, argv: ['claude'], env: 'SETI_TASK_ID=other\0' })
    const { view } = await readProcesses('fixture', null, { proc: new Proc(root), serverPid: 1 })
    expect(view.processes.map((p) => [p.pid, p.kind, p.depth])).toEqual([
      [10, 'agent', 0],
      [11, 'command', 1],
      [12, 'seti', 1],
      [13, 'tool', 1],
    ])
    expect(view.processes[1]?.command).toBe('/usr/bin/zsh -c npm publish --token=[redacted]')
    expect(view.processes[0]?.rss_bytes).toBe(2048 * 1024)
    expect(view.running).toBe(1)
  })
})
