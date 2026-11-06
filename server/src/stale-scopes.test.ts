import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { tasks } from './db.js'
import { startedHere, unitName, type ScopeHost } from './memory-scope.js'
import { Proc } from './proc.js'
import { parseShow, parseUnit, stopLeftoverScopes, stopStaleScopes, type Sweep } from './stale-scopes.js'
import { auditEvents } from './store/audit.js'

const OURS = 'aaaaaaaa'
const TASK = 'b1632abd-a2dd-4fa2-b8ff-c415fca04aae'
const MANAGER_PID = 975
const LIVE_SETI_PID = 4000

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-stale-scopes-'))
const procRoot = path.join(root, 'proc')
const cgroupRoot = path.join(root, 'cgroup')
const showFile = path.join(root, 'show.txt')
const callLog = path.join(root, 'calls.log')
const slowFlag = path.join(root, 'slow')
const systemctl = path.join(root, 'systemctl')

fs.writeFileSync(
  systemctl,
  [
    '#!/bin/sh',
    `echo "$*" >> '${callLog}'`,
    'case "$2" in',
    `  show) cat '${showFile}' ;;`,
    `  stop) [ -f '${slowFlag}' ] && exec sleep 5 ;;`,
    'esac',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 },
)

const host: ScopeHost = { systemdRun: 'systemd-run', systemctl, runtimeDir: root, bindTo: null, cpu: false }

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function processAt(pid: number, ppid: number, cgroup: string) {
  const dir = path.join(procRoot, String(pid))
  fs.mkdirSync(dir, { recursive: true })
  const fields = ['S', ppid, pid, pid, 0, -1, 0, 0, 0, 0, 0, 30, 20, 0, 0, 20, 0, 1, 0, 5000]
  fs.writeFileSync(path.join(dir, 'stat'), `${String(pid)} (p${String(pid)}) ${fields.join(' ')}`)
  fs.writeFileSync(path.join(dir, 'cgroup'), `0::${cgroup}\n`)
}

/** A scope as `systemctl show` lists it, with its processes and their parents. */
function scope(unit: string, state: string, members: [pid: number, ppid: number][]) {
  const cgroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}`
  fs.mkdirSync(path.join(cgroupRoot, cgroup), { recursive: true })
  fs.writeFileSync(path.join(cgroupRoot, cgroup, 'cgroup.procs'), members.map(([pid]) => `${String(pid)}\n`).join(''))
  for (const [pid, ppid] of members) {
    processAt(pid, ppid, cgroup)
  }
  return `ControlGroup=${cgroup}\nId=${unit}\nActiveState=${state}\n`
}

const orphan = `seti-${OURS}-agent-${TASK}-11111111.scope`
const orphanShell = `seti-${OURS}-shell-${TASK}-22222222.scope`
const ownScope = `seti-${OURS}-agent-${TASK}-33333333.scope`
const otherInstance = `seti-bbbbbbbb-agent-${TASK}-44444444.scope`
const heldScope = `seti-${OURS}-agent-${TASK}-55555555.scope`
const stopping = `seti-${OURS}-terminal-${TASK}-66666666.scope`
const empty = `seti-${OURS}-agent-${TASK}-77777777.scope`

const sweep: Sweep = {
  host,
  instance: OURS,
  startedHere: (unit) => unit === ownScope,
  proc: new Proc(procRoot),
  cgroupRoot,
}

const shown = new Map<string, string>()

function show(units: readonly string[]) {
  fs.writeFileSync(showFile, units.map((unit) => shown.get(unit) ?? '').join('\n'))
}

const calls = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n') : [])

beforeEach(() => {
  fs.rmSync(callLog, { force: true })
  fs.rmSync(slowFlag, { force: true })
  processAt(1, 0, '/init.scope')
  processAt(MANAGER_PID, 1, '/user.slice/user-1000.slice/user@1000.service/init.scope')
  processAt(LIVE_SETI_PID, MANAGER_PID, '/user.slice/user-1000.slice/user@1000.service/app.slice/seti.service')
  shown.set(
    orphan,
    scope(orphan, 'active', [
      [100, MANAGER_PID],
      [101, 100],
      [102, 101],
    ]),
  )
  shown.set(orphanShell, scope(orphanShell, 'active', [[200, 1]]))
  shown.set(ownScope, scope(ownScope, 'active', [[300, process.pid]]))
  shown.set(otherInstance, scope(otherInstance, 'active', [[400, MANAGER_PID]]))
  shown.set(
    heldScope,
    scope(heldScope, 'active', [
      [500, LIVE_SETI_PID],
      [501, MANAGER_PID],
    ]),
  )
  shown.set(stopping, scope(stopping, 'deactivating', [[600, MANAGER_PID]]))
  shown.set(empty, scope(empty, 'active', []))
  show([...shown.keys()])
})

describe('reading scope units', () => {
  it('splits systemctl show output into one property map per unit', () => {
    const units = parseShow('Id=a.scope\nActiveState=active\n\nId=b.scope\nControlGroup=/x=y\n\n')
    expect(units.map((props) => Object.fromEntries(props))).toEqual([
      { Id: 'a.scope', ActiveState: 'active' },
      { Id: 'b.scope', ControlGroup: '/x=y' },
    ])
    expect(parseShow('')).toEqual([])
  })

  it('reads the kind and task of this instance only', () => {
    expect(parseUnit(orphan, OURS)).toEqual({ kind: 'agent', taskId: TASK })
    expect(parseUnit(`seti-${OURS}-terminal-t_1-0a0b0c0d.scope`, OURS)).toEqual({ kind: 'terminal', taskId: 't_1' })
    expect(parseUnit(otherInstance, OURS)).toBeNull()
    expect(parseUnit(`seti-${OURS}-other-t-0a0b0c0d.scope`, OURS)).toBeNull()
    expect(parseUnit(`seti-${OURS}-agent-t-0a0b0c0d.service`, OURS)).toBeNull()
    expect(parseUnit('seti.service', OURS)).toBeNull()
  })

  it('counts each scope this process names as its own', () => {
    const unit = unitName(TASK, 'agent')
    expect(startedHere(unit)).toBe(true)
    expect(startedHere(unit.replace(/-[0-9a-f]{8}\.scope$/, '-00000000.scope'))).toBe(false)
  })
})

describe('stopping scopes an earlier run left', () => {
  it('stops only the orphaned scopes of this instance, and says what they held', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const stopped = await stopStaleScopes(sweep)
    const lines = out.mock.calls.map(([line]) => String(line))
    out.mockRestore()
    expect(stopped).toEqual([
      { unit: orphan, kind: 'agent', taskId: TASK, pids: [100, 101, 102] },
      { unit: orphanShell, kind: 'shell', taskId: TASK, pids: [200] },
    ])
    expect(calls()).toEqual([
      `--user show --property=Id,ActiveState,ControlGroup seti-${OURS}-*.scope`,
      `--user stop ${orphan} ${orphanShell}`,
    ])
    expect(lines).toEqual([
      `scopes: stopping ${orphan} of task ${TASK} from an earlier run, 3 processes\n`,
      `scopes: stopping ${orphanShell} of task ${TASK} from an earlier run, 1 processes\n`,
    ])
  })

  it("stops nothing when each scope is this run's, still held, stopping or another instance's", async () => {
    show([ownScope, otherInstance, heldScope, stopping, empty])
    expect(await stopStaleScopes(sweep)).toEqual([])
    expect(calls()).toHaveLength(1)
  })

  it('goes on with startup when the stop outlasts its wait', async () => {
    fs.writeFileSync(slowFlag, '')
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    const started = Date.now()
    const stopped = await stopStaleScopes(sweep, 200)
    const elapsed = Date.now() - started
    const errors = err.mock.calls.map(([line]) => String(line))
    err.mockRestore()
    out.mockRestore()
    expect(stopped.map((s) => s.unit)).toEqual([orphan, orphanShell])
    expect(elapsed).toBeLessThan(4000)
    expect(errors.some((line) => line.startsWith("scopes: stopping earlier runs' scopes did not finish"))).toBe(true)
  })

  it('audits each stop under the task it belonged to', async () => {
    const cwd = fs.mkdtempSync(path.join(root, 'cwd-'))
    await tasks.insert({ id: TASK, title: 'Orphans', repo_id: null, cwd, worktree: false, pr_urls: [] })
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await stopLeftoverScopes(sweep)
    vi.restoreAllMocks()
    await auditEvents.settled()
    const event = await auditEvents.latest('task.process_stopped')
    expect(event).toMatchObject({
      actor: 'system',
      subject_type: 'task',
      subject_id: TASK,
      summary: 'Stopped the shell processes an earlier Seti run left in task "Orphans"',
      detail: { title: 'Orphans', unit: orphanShell, kind: 'shell', processes: 1, stale: true },
    })
  })

  it('does nothing without a user manager to ask', async () => {
    expect(await stopLeftoverScopes({})).toEqual([])
    expect(calls()).toEqual([])
  })
})
