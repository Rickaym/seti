import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { memoryScopeSchema } from '@seti/shared'
import { audit } from './audit.js'
import { tasks } from './db.js'
import {
  CGROUP_ROOT,
  SCOPE_INSTANCE,
  scopeHost,
  startedHere,
  unifiedPath,
  userBus,
  type ScopeHost,
  type ScopeKind,
} from './memory-scope.js'
import { Proc } from './proc.js'

const run = promisify(execFile)

/** How long startup waits for the stops; systemd goes on with any still running after it. */
const STOP_WAIT_MS = 15_000

/** A scope an earlier run of this Seti started, with the processes still in it. */
interface StaleScope {
  unit: string
  taskId: string
  kind: ScopeKind
  pids: number[]
}

/** Where to look: the user manager, this instance's scopes, and /proc and cgroupfs to read them. */
export interface Sweep {
  host: ScopeHost
  instance: string
  startedHere: (unit: string) => boolean
  proc: Proc
  cgroupRoot: string
}

/** The properties of each unit in `systemctl show` output, which puts a blank line between units. */
export function parseShow(text: string): Map<string, string>[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const props = new Map<string, string>()
      for (const line of block.split('\n')) {
        const at = line.indexOf('=')
        if (at > 0) {
          props.set(line.slice(0, at), line.slice(at + 1))
        }
      }
      return props
    })
    .filter((props) => props.size > 0)
}

const SCOPE_KINDS = memoryScopeSchema.shape.kind.options

/** The kind and task of a scope `instance` named, or null for any other unit. */
export function parseUnit(unit: string, instance: string): { kind: ScopeKind; taskId: string } | null {
  const match = /^seti-([0-9a-f]{8})-(agent|side_chat|shell|terminal)-([\w-]+)-[0-9a-f]{8}\.scope$/.exec(unit)
  const [, owner, kind, taskId] = match ?? []
  const known = SCOPE_KINDS.find((k) => k === kind)
  if (owner !== instance || taskId === undefined || known === undefined) {
    return null
  }
  return { kind: known, taskId }
}

const inInitScope = (proc: Proc, pid: number) =>
  unifiedPath(proc.read(String(pid), 'cgroup') ?? '')?.endsWith('/init.scope') === true

/**
 * True while a live process outside the scope, such as another Seti on this home and port, is the
 * parent of one in it. A dead Seti's processes belong to the user manager or init instead.
 */
function held(proc: Proc, pids: readonly number[]): boolean {
  const members = new Set(pids)
  return pids.some((pid) => {
    const ppid = proc.stat(pid)?.ppid ?? 0
    return ppid > 1 && !members.has(ppid) && !inInitScope(proc, ppid)
  })
}

const readPids = (file: string) => {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

/** This instance's active scopes with processes left that no live Seti started or holds. */
async function staleScopes(sweep: Sweep): Promise<StaleScope[]> {
  const args = ['--user', 'show', '--property=Id,ActiveState,ControlGroup', `seti-${sweep.instance}-*.scope`]
  const { stdout } = await run(sweep.host.systemctl, args, userBus(sweep.host))
  return parseShow(stdout).flatMap((props) => {
    const unit = props.get('Id') ?? ''
    const parsed = parseUnit(unit, sweep.instance)
    const cgroup = props.get('ControlGroup') ?? ''
    if (parsed === null || sweep.startedHere(unit) || props.get('ActiveState') !== 'active' || cgroup === '') {
      return []
    }
    const pids = readPids(path.join(sweep.cgroupRoot, cgroup, 'cgroup.procs'))
    return pids.length === 0 || held(sweep.proc, pids) ? [] : [{ unit, ...parsed, pids }]
  })
}

/** Stops the stale scopes and says in the journal what each held; returns those it stopped. */
export async function stopStaleScopes(sweep: Sweep, waitMs = STOP_WAIT_MS): Promise<StaleScope[]> {
  const stale = await staleScopes(sweep)
  if (stale.length === 0) {
    return []
  }
  for (const scope of stale) {
    process.stdout.write(
      `scopes: stopping ${scope.unit} of task ${scope.taskId} from an earlier run, ` +
        `${String(scope.pids.length)} processes\n`,
    )
  }
  const args = ['--user', 'stop', ...stale.map((scope) => scope.unit)]
  try {
    await run(sweep.host.systemctl, args, { ...userBus(sweep.host), timeout: waitMs })
  } catch (e) {
    process.stderr.write(`scopes: stopping earlier runs' scopes did not finish: ${String(e)}\n`)
  }
  return stale
}

async function auditStopped(scope: StaleScope): Promise<void> {
  const task = await tasks.get(scope.taskId)
  const title = task?.title ?? null
  await audit.record({
    actor: 'system',
    kind: 'task.process_stopped',
    subject_type: 'task',
    subject_id: scope.taskId,
    summary: `Stopped the ${scope.kind} processes an earlier Seti run left in task "${title ?? scope.taskId}"`,
    detail: { title, unit: scope.unit, kind: scope.kind, processes: scope.pids.length, stale: true },
  })
}

/**
 * Stops what a dead Seti's agents, shells and terminals left running, before this run starts any:
 * no one controls those sessions, and they would act on the same worktree as the new ones.
 */
export async function stopLeftoverScopes(sweep: Partial<Sweep> = {}): Promise<StaleScope[]> {
  const host = sweep.host ?? (await scopeHost())
  if (host === null) {
    return []
  }
  try {
    const stopped = await stopStaleScopes({
      host,
      instance: sweep.instance ?? SCOPE_INSTANCE,
      startedHere: sweep.startedHere ?? startedHere,
      proc: sweep.proc ?? new Proc(),
      cgroupRoot: sweep.cgroupRoot ?? CGROUP_ROOT,
    })
    for (const scope of stopped) {
      await auditStopped(scope)
    }
    return stopped
  } catch (e) {
    process.stderr.write(`scopes: could not stop earlier runs' scopes: ${String(e)}\n`)
    return []
  }
}
