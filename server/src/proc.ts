import fs from 'node:fs'
import path from 'node:path'

/** USER_HZ, the unit of the times in /proc; Linux fixes it at 100 on every architecture it runs. */
export const CLOCK_TICKS = 100

export interface ProcStat {
  pid: number
  comm: string
  state: string
  ppid: number
  /** The kernel's PF_* flags, such as PF_FORKNOEXEC. */
  flags: number
  /** User plus system time, in clock ticks. */
  cpuTicks: number
  threads: number
  /** Clock ticks after boot at which the process started. */
  startTicks: number
}

export interface ProcStatus {
  rssBytes: number
  /** Private memory, which adds up across processes where RSS counts shared pages twice. */
  anonBytes: number
  /** File-backed and shared memory pages, which sibling processes may share. */
  sharedBytes: number
  swapBytes: number
  threads: number
  /** The pid in the innermost pid namespace, such as a sandbox's; the host pid outside one. */
  nsPid: number | null
}

export interface CpuTimes {
  busy: number
  total: number
}

export interface Meminfo {
  totalBytes: number
  availableBytes: number
  swapTotalBytes: number
  swapFreeBytes: number
}

/** Parses /proc/<pid>/stat; the command name sits in parentheses and may hold spaces or ')'. */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) {
    return null
  }
  const fields = text
    .slice(close + 2)
    .trim()
    .split(' ')
  const field = (n: number) => Number(fields[n - 3])
  const stat = {
    pid: Number(text.slice(0, open).trim()),
    comm: text.slice(open + 1, close),
    state: fields[0] ?? '?',
    ppid: field(4),
    flags: field(9),
    cpuTicks: field(14) + field(15),
    threads: field(20),
    startTicks: field(22),
  }
  return Number.isFinite(stat.pid) && Number.isFinite(stat.startTicks) ? stat : null
}

const kbField = (text: string, name: string): number | null => {
  const match = new RegExp(`^${name}:\\s+(\\d+)`, 'm').exec(text)
  return match?.[1] === undefined ? null : Number(match[1])
}

export function parseStatus(text: string): ProcStatus {
  return {
    rssBytes: (kbField(text, 'VmRSS') ?? 0) * 1024,
    anonBytes: (kbField(text, 'RssAnon') ?? 0) * 1024,
    sharedBytes: ((kbField(text, 'RssFile') ?? 0) + (kbField(text, 'RssShmem') ?? 0)) * 1024,
    swapBytes: (kbField(text, 'VmSwap') ?? 0) * 1024,
    threads: kbField(text, 'Threads') ?? 0,
    nsPid: nsPidOf(text),
  }
}

function nsPidOf(text: string): number | null {
  const line = text.split('\n').find((l) => l.startsWith('NSpid:'))
  const last = line?.slice('NSpid:'.length).trim().split(/\s+/).at(-1)
  return last === undefined || last === '' ? null : Number(last)
}

/** The aggregate cpu line of /proc/stat; iowait counts as idle, as top and vmstat count it. */
export function parseCpuTimes(text: string): CpuTimes {
  const line = text.split('\n').find((l) => l.startsWith('cpu '))
  const values = (line ?? '').trim().split(/\s+/).slice(1).map(Number)
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = values
  const busy = user + nice + system + irq + softirq + steal
  return { busy, total: busy + idle + iowait }
}

/** Boot time in epoch seconds, from the btime line of /proc/stat. */
export function parseBootTime(text: string): number {
  return Number(/^btime\s+(\d+)/m.exec(text)?.[1] ?? 0)
}

export function parseMeminfo(text: string): Meminfo {
  const kb = (name: string) => (kbField(text, name) ?? 0) * 1024
  return {
    totalBytes: kb('MemTotal'),
    availableBytes: kb('MemAvailable'),
    swapTotalBytes: kb('SwapTotal'),
    swapFreeBytes: kb('SwapFree'),
  }
}

/** Busy share of all CPUs between two readings, 0 to 100, or null without a usable delta. */
export function hostCpuPercent(prev: CpuTimes | null, cur: CpuTimes): number | null {
  if (prev === null || cur.total <= prev.total) {
    return null
  }
  return Math.min(100, Math.max(0, (100 * (cur.busy - prev.busy)) / (cur.total - prev.total)))
}

/** Percent of one CPU a process used between two readings `elapsedMs` apart. */
export function processCpuPercent(prevTicks: number, curTicks: number, elapsedMs: number): number | null {
  if (elapsedMs <= 0 || curTicks < prevTicks) {
    return null
  }
  return (100 * (curTicks - prevTicks)) / ((elapsedMs / 1000) * CLOCK_TICKS)
}

/** One variable of a NUL-separated /proc/<pid>/environ, never the rest of it. */
export function environValue(text: string, name: string): string | null {
  const prefix = `${name}=`
  const entry = text.split('\0').find((e) => e.startsWith(prefix))
  return entry === undefined ? null : entry.slice(prefix.length)
}

const TCP_LISTEN = '0A'

/** Socket inodes listening on `port` in /proc/net/tcp or tcp6. */
export function listeningInodes(text: string, port: number): string[] {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0')
  return text
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols[1]?.endsWith(`:${hexPort}`) === true && cols[3] === TCP_LISTEN)
    .flatMap((cols) => (cols[9] === undefined ? [] : [cols[9]]))
}

/** The data directory a postmaster started with, from its NUL-separated command line. */
export function postmasterDataDir(cmdline: string): string | null {
  const args = cmdline.split('\0')
  const at = args.indexOf('-D')
  if (at >= 0) {
    return args[at + 1] ?? null
  }
  const joined = args.find((a) => a.startsWith('-D') && a.length > 2)
  return joined === undefined ? null : joined.slice(2)
}

export function parseRedisInfo(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0 && !line.startsWith('#')) {
      fields.set(line.slice(0, at), line.slice(at + 1).trim())
    }
  }
  return fields
}

/** The mount point holding `target`: the longest mount path that contains it. */
export function mountOf(mounts: string, target: string): string {
  const points = mounts
    .split('\n')
    .map((line) => line.split(' ')[1]?.replace(/\\040/g, ' '))
    .filter((point) => point !== undefined)
  const inside = points.filter(
    (point) => point === '/' || target === point || target.startsWith(point.endsWith('/') ? point : `${point}/`),
  )
  return inside.reduce((best, point) => (point.length > best.length ? point : best), '/')
}

/** Reads /proc, or a fixture tree laid out like it in tests. */
export class Proc {
  readonly root: string

  constructor(root = '/proc') {
    this.root = root
  }

  read(...parts: string[]): string | null {
    try {
      return fs.readFileSync(path.join(this.root, ...parts), 'utf8')
    } catch {
      return null
    }
  }

  pids(): number[] {
    return fs
      .readdirSync(this.root)
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
  }

  stat(pid: number): ProcStat | null {
    const text = this.read(String(pid), 'stat')
    return text === null ? null : parseStat(text)
  }

  status(pid: number): ProcStatus | null {
    const text = this.read(String(pid), 'status')
    return text === null ? null : parseStatus(text)
  }

  /** Every process readable now; ones that exit while being read are left out. */
  processes(): ProcStat[] {
    return this.pids().flatMap((pid) => {
      const stat = this.stat(pid)
      return stat === null ? [] : [stat]
    })
  }

  /** Whether the process holds the socket inode; false when its fds are not ours to read. */
  ownsSocket(pid: number, inodes: ReadonlySet<string>): boolean {
    try {
      const dir = path.join(this.root, String(pid), 'fd')
      return fs.readdirSync(dir).some((fd) => {
        try {
          const target = fs.readlinkSync(path.join(dir, fd))
          return inodes.has(/^socket:\[(\d+)\]$/.exec(target)?.[1] ?? '')
        } catch {
          return false
        }
      })
    } catch {
      return false
    }
  }

  /** The command line's arguments; empty for kernel threads and processes that exited. */
  cmdline(pid: number): string[] {
    const text = this.read(String(pid), 'cmdline') ?? ''
    return text === '' ? [] : text.replace(/\0$/, '').split('\0')
  }

  /** Where the process's open file descriptors point; empty when they are not ours to read. */
  fdTargets(pid: number): string[] {
    const dir = path.join(this.root, String(pid), 'fd')
    try {
      return fs.readdirSync(dir).flatMap((fd) => {
        try {
          return [fs.readlinkSync(path.join(dir, fd))]
        } catch {
          return []
        }
      })
    } catch {
      return []
    }
  }

  /**
   * Children of every thread of the process, from the kernel's children files, without reading
   * every process on the host; null where the kernel has no such files.
   */
  childPids(pid: number): number[] | null {
    let threads: string[]
    try {
      threads = fs.readdirSync(path.join(this.root, String(pid), 'task'))
    } catch {
      return []
    }
    const found: number[] = []
    for (const tid of threads) {
      const text = this.read(String(pid), 'task', tid, 'children')
      if (text === null && fs.existsSync(path.join(this.root, String(pid), 'task', tid))) {
        return null
      }
      found.push(
        ...(text ?? '')
          .split(' ')
          .filter((word) => word !== '')
          .map(Number),
      )
    }
    return found
  }

  ownerUid(pid: number): number | null {
    try {
      return fs.statSync(path.join(this.root, String(pid))).uid
    } catch {
      return null
    }
  }
}

/** Children by parent pid from every process on the host, where the kernel lacks children files. */
function scanChildren(proc: Proc): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const stat of proc.processes()) {
    children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), stat.pid])
  }
  return children
}

/** Looks up a process's children, scanning every process once if the kernel cannot list them. */
export function childLookup(proc: Proc): (pid: number) => number[] {
  let scanned: Map<number, number[]> | null = null
  return (pid) => {
    if (scanned === null) {
      const direct = proc.childPids(pid)
      if (direct !== null) {
        return direct
      }
      scanned = scanChildren(proc)
    }
    return scanned.get(pid) ?? []
  }
}
