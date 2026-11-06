import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { binaryPath } from './binaries.js'
import type { Proc } from './proc.js'

const run = promisify(execFile)

/** The kernel adds adj/1000 of the scope's limit to a process's size when it picks a victim. */
export const TOOL_OOM_ADJ = 800

/** What sits between systemd-run and Claude Code: the scope's launcher and the sandbox. */
const LAUNCHERS = new Set(['systemd-run', 'env', 'bwrap'])
const LAUNCH_DEPTH = 6
const LABEL_CHARS = 40

const INTERPRETERS = /^(node|nodejs|bun|deno|tsx|ts-node|python[\d.]*|ruby|perl)$/
const SCRIPT_SUFFIX = /(-cli)?(\.[cm]?[jt]s|\.py|\.rb)?$/

/** A process by the program people know it as: tsc, not node or MainThread. */
export function processLabel(comm: string, argv: readonly string[]): string {
  const file = path.basename(argv[0] ?? '')
  const program = file === '' ? comm : file
  if (INTERPRETERS.test(program)) {
    const script = argv.slice(1).find((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg))
    const name = script === undefined ? '' : path.basename(script).replace(SCRIPT_SUFFIX, '')
    if (name !== '' && !name.includes(' ')) {
      return name.slice(0, LABEL_CHARS)
    }
  }
  return program.slice(0, LABEL_CHARS)
}

/** The sandbox's bridge to the task proxy, and setpriv before it execs it. */
const isProxyBridge = (comm: string, argv: readonly string[]) =>
  (comm === 'socat' || comm === 'setpriv') && argv.some((arg) => arg.includes('proxy.sock'))

type Role = 'root' | 'launcher' | 'helper' | 'tool'

/** A tool's label before its exec, while a shell that may exec its command, or for good. */
type Naming = 'pending' | 'shell' | 'named'

interface Known {
  role: Role
  start: number
  naming?: Naming
}

/** Set from fork until exec, while the command line is still the parent's. */
const PF_FORKNOEXEC = 0x40

const SHELLS = new Set(['sh', 'dash', 'bash', 'zsh'])

/** A shell's label holds only while the process still has the shell's name; it may exec since. */
interface Label {
  name: string
  shellComm: string | null
}

/** Makes every process below a scope's root, Claude Code for an agent, the kernel's first pick. */
export class ToolGuard {
  private readonly proc: Proc
  private readonly launchPid: number
  private root: { pid: number; start: number } | null = null
  private readonly known = new Map<number, Known>()
  private readonly labels = new Map<number, Label>()

  constructor(proc: Proc, launchPid: number) {
    this.proc = proc
    this.launchPid = launchPid
  }

  /** Raises the adj of each tool it has not seen, and names the tools that ran a new program. */
  tick(pids: readonly number[]): void {
    const present = new Set(pids)
    for (const pid of this.known.keys()) {
      if (!present.has(pid)) {
        this.known.delete(pid)
      }
    }
    if (this.root === null && !this.findRoot(present)) {
      return
    }
    for (const pid of pids) {
      const known = this.known.get(pid)
      if (known === undefined || (known.role === 'tool' && known.naming !== 'named')) {
        this.classify(pid, known)
      }
    }
  }

  /** Follows the launchers down from the process systemd-run started to the first that is not one. */
  private findRoot(present: ReadonlySet<number>): boolean {
    const stats = [...present].flatMap((pid) => {
      const stat = this.proc.stat(pid)
      return stat === null ? [] : [stat]
    })
    let current = stats.find((stat) => stat.pid === this.launchPid)
    const launchers: number[] = []
    for (let depth = 0; current !== undefined && depth < LAUNCH_DEPTH; depth++) {
      if (!LAUNCHERS.has(current.comm)) {
        this.root = { pid: current.pid, start: current.startTicks }
        this.known.set(current.pid, { role: 'root', start: current.startTicks })
        for (const pid of launchers) {
          this.known.set(pid, { role: 'launcher', start: 0 })
        }
        return true
      }
      launchers.push(current.pid)
      const parent = current.pid
      current = stats
        .filter((stat) => stat.ppid === parent)
        .toSorted((a, b) => (a.startTicks === b.startTicks ? a.pid - b.pid : a.startTicks - b.startTicks))[0]
    }
    return false
  }

  /** Raises a new process at once, and names it once it runs its own program, not its parent's. */
  private classify(pid: number, known: Known | undefined): void {
    const stat = this.proc.stat(pid)
    if (stat === null || (known?.naming === 'shell' && this.labels.get(pid)?.shellComm === stat.comm)) {
      return
    }
    const argv = (stat.flags & PF_FORKNOEXEC) === 0 ? this.proc.cmdline(pid) : []
    if (argv.length === 0) {
      this.known.set(pid, { role: 'tool', start: stat.startTicks, naming: 'pending' })
      this.raise(pid)
      return
    }
    if (isProxyBridge(stat.comm, argv)) {
      this.known.set(pid, { role: 'helper', start: stat.startTicks })
      if (known !== undefined) {
        this.lower(pid)
      }
      return
    }
    const label = processLabel(stat.comm, argv)
    const shell = SHELLS.has(label)
    this.known.set(pid, { role: 'tool', start: stat.startTicks, naming: shell ? 'shell' : 'named' })
    this.remember(pid, { name: label, shellComm: shell ? stat.comm : null })
    this.raise(pid)
  }

  /** Puts a helper the guard raised before it exec'd back at the root's adj. */
  private lower(pid: number): void {
    const adj = this.root === null ? null : this.proc.read(String(this.root.pid), 'oom_score_adj')
    if (adj === null) {
      return
    }
    try {
      fs.writeFileSync(path.join(this.proc.root, String(pid), 'oom_score_adj'), adj.trim())
    } catch {
      return
    }
  }

  private remember(pid: number, label: Label): void {
    if (this.labels.size >= 4096) {
      this.labels.delete(this.labels.keys().next().value ?? pid)
    }
    this.labels.set(pid, label)
  }

  /** False when the process is gone or will not take the change, such as a setuid program. */
  private raise(pid: number): boolean {
    const file = path.join(this.proc.root, String(pid), 'oom_score_adj')
    try {
      if (Number(fs.readFileSync(file, 'utf8').trim()) < TOOL_OOM_ADJ) {
        fs.writeFileSync(file, String(TOOL_OOM_ADJ))
      }
      return true
    } catch {
      return false
    }
  }

  /** The root, or before the guard found it the process systemd-run started. */
  isRoot(pid: number): boolean {
    return (this.root?.pid ?? this.launchPid) === pid
  }

  /** The root's process is gone or a zombie. */
  rootGone(): boolean {
    const stat = this.proc.stat(this.root?.pid ?? this.launchPid)
    const replaced = this.root !== null && stat?.startTicks !== this.root.start
    return stat === null || replaced || stat.state === 'Z' || stat.state === 'X'
  }

  /** What the guard named the process, unless the kernel's name for it shows it ran another program. */
  labelOf(pid: number, comm: string): string | null {
    const label = this.labels.get(pid)
    return label === undefined || (label.shellComm !== null && label.shellComm !== comm) ? null : label.name
  }
}

export interface OomKill {
  pid: number
  comm: string
}

const OOM_KILL_LINE = /oom-kill:.*\boom_memcg=([^,]+),.*\btask=(.*),pid=(\d+),uid=\d+/

/** The kernel's oom-kill lines for kills inside `unit`, oldest first. */
export function parseOomKills(log: string, unit: string): OomKill[] {
  return log.split('\n').flatMap((line) => {
    const match = OOM_KILL_LINE.exec(line)
    if (match === null || !(match[1] ?? '').endsWith(`/${unit}`)) {
      return []
    }
    return [{ comm: match[2] ?? '', pid: Number(match[3]) }]
  })
}

const JOURNAL_TIMEOUT_MS = 3000

/** OOM kills inside `unit` since `sinceMs` from the kernel log, or null where it is unreadable. */
export async function kernelOomKills(unit: string, sinceMs: number): Promise<OomKill[] | null> {
  const journalctl = binaryPath('journalctl')
  if (journalctl === null) {
    return null
  }
  const since = `@${String(Math.floor(sinceMs / 1000))}`
  try {
    const { stdout } = await run(journalctl, ['-k', '-q', '-o', 'cat', '--no-pager', `--since=${since}`], {
      timeout: JOURNAL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parseOomKills(stdout, unit)
  } catch {
    return null
  }
}
