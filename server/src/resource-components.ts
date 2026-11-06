import type { ComponentId, ComponentResources } from '@seti/shared'
import { EA_URL, PUBLIC_ACCESS, REDIS_URL } from './config.js'
import { listeningInodes, parseRedisInfo, postmasterDataDir, type Proc, type ProcStat } from './proc.js'
import { ageS, descendants, groupUsage, type Scan } from './process-scan.js'
import { redisInfo } from './redis.js'
import { databaseStats } from './store/resources.js'

const DATABASE_REFRESH_MS = 60_000
const EA_SEARCH_MS = 60_000
const QUERY_TIMEOUT_MS = 2000

interface ComponentSpec {
  id: ComponentId
  name: string
  root: ProcStat | null
  state: ComponentResources['state']
  detail?: ComponentResources['detail']
  /** Overrides the root process's age, for a server that reports its own uptime. */
  uptime?: number
}

interface DatabaseState {
  at: number
  postmaster: ProcStat | null
  dataDir: string | null
  bytes: number
}

async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null)
    }, ms)
  })
  try {
    return await Promise.race([work.catch(() => null), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const uid = process.getuid?.() ?? -1

/** Finds Seti's own services among the scanned processes and measures each with its children. */
export class ComponentProbe {
  private readonly proc: Proc
  private readonly serverPid: number
  private ea: { pid: number; startTicks: number } | null = null
  private eaSearchedAt = Number.NEGATIVE_INFINITY
  private database: DatabaseState | null = null

  constructor(proc: Proc, serverPid: number) {
    this.proc = proc
    this.serverPid = serverPid
  }

  /** The Postgres data directory, once a sample has found the postmaster. */
  get dataDir(): string | null {
    return this.database?.dataDir ?? null
  }

  async all(scan: Scan): Promise<ComponentResources[]> {
    const [postgres, redis] = await Promise.all([this.postgres(scan), this.redis(scan)])
    return [this.server(scan), this.eaService(scan), postgres, redis, this.cloudflared(scan)]
  }

  private component(scan: Scan, spec: ComponentSpec): ComponentResources {
    const { root } = spec
    const members = root === null ? [] : [root, ...(spec.id === 'server' ? [] : descendants(scan.children, root.pid))]
    return {
      id: spec.id,
      name: spec.name,
      state: spec.state,
      pid: root?.pid ?? null,
      ...groupUsage(this.proc, scan, members),
      uptime_s: spec.uptime ?? (root === null ? null : ageS(scan, root)),
      detail: spec.detail ?? null,
    }
  }

  private server(scan: Scan): ComponentResources {
    return this.component(scan, {
      id: 'server',
      name: 'Seti server',
      root: scan.byPid.get(this.serverPid) ?? null,
      state: 'up',
      detail: { label: 'heap', bytes: process.memoryUsage().heapUsed },
    })
  }

  /** The process listening on the EA port; open fds are searched at most once a minute. */
  private eaService(scan: Scan): ComponentResources {
    const { port: explicit } = new URL(EA_URL)
    const port = explicit === '' ? 80 : Number(explicit)
    const tables = [this.proc.read('net', 'tcp'), this.proc.read('net', 'tcp6')]
    const inodes = new Set(tables.flatMap((text) => (text === null ? [] : listeningInodes(text, port))))
    const spec = { id: 'ea', name: 'EA service' } as const
    if (inodes.size === 0) {
      return this.component(scan, { ...spec, root: null, state: 'down' })
    }
    const known = this.ea === null ? undefined : scan.byPid.get(this.ea.pid)
    let root = known?.startTicks === this.ea?.startTicks ? (known ?? null) : null
    if (root === null && scan.now - this.eaSearchedAt >= EA_SEARCH_MS) {
      this.eaSearchedAt = scan.now
      root = this.findListener(scan, inodes)
      this.ea = root === null ? null : { pid: root.pid, startTicks: root.startTicks }
    }
    return this.component(scan, { ...spec, root, state: 'up' })
  }

  private findListener(scan: Scan, inodes: ReadonlySet<string>): ProcStat | null {
    const mine = [...scan.byPid.values()].filter((stat) => this.proc.ownerUid(stat.pid) === uid)
    mine.sort((a, b) => Number(b.comm.startsWith('python')) - Number(a.comm.startsWith('python')))
    return mine.find((stat) => this.proc.ownsSocket(stat.pid, inodes)) ?? null
  }

  /** Asks Postgres for a backend of Seti's, whose parent is the postmaster, and the database size. */
  private async refreshDatabase(scan: Scan): Promise<DatabaseState | null> {
    const stats = await within(databaseStats(), QUERY_TIMEOUT_MS)
    if (stats === null) {
      return null
    }
    const backend = this.proc.stat(stats.backendPid)
    const parent = backend === null ? null : this.proc.stat(backend.ppid)
    const postmaster = parent?.comm === 'postgres' ? parent : null
    const cmdline = postmaster === null ? null : this.proc.read(String(postmaster.pid), 'cmdline')
    return {
      at: scan.now,
      postmaster,
      dataDir: cmdline === null ? null : postmasterDataDir(cmdline),
      bytes: stats.databaseBytes,
    }
  }

  private databaseStale(scan: Scan): boolean {
    const known = this.database
    if (known === null || scan.now - known.at >= DATABASE_REFRESH_MS) {
      return true
    }
    return known.postmaster !== null && !scan.byPid.has(known.postmaster.pid)
  }

  private async postgres(scan: Scan): Promise<ComponentResources> {
    const spec = { id: 'postgres', name: 'PostgreSQL' } as const
    if (this.databaseStale(scan)) {
      this.database = await this.refreshDatabase(scan)
    }
    if (this.database === null) {
      return this.component(scan, { ...spec, root: null, state: 'down' })
    }
    const { postmaster, bytes } = this.database
    const root = postmaster === null ? null : (scan.byPid.get(postmaster.pid) ?? null)
    return this.component(scan, { ...spec, root, state: 'up', detail: { label: 'database', bytes } })
  }

  private async redis(scan: Scan): Promise<ComponentResources> {
    const spec = { id: 'redis', name: 'Redis' } as const
    if (REDIS_URL === 'off') {
      return this.component(scan, { ...spec, root: null, state: 'off' })
    }
    const info = await within(redisInfo(), QUERY_TIMEOUT_MS)
    if (info === null) {
      return this.component(scan, { ...spec, root: null, state: 'down' })
    }
    const fields = parseRedisInfo(info)
    const stat = scan.byPid.get(Number(fields.get('process_id') ?? '-1'))
    return this.component(scan, {
      ...spec,
      root: stat?.comm.startsWith('redis') === true ? stat : null,
      state: 'up',
      detail: { label: 'used_memory', bytes: Number(fields.get('used_memory') ?? '0') },
      uptime: Number(fields.get('uptime_in_seconds') ?? '0'),
    })
  }

  private cloudflared(scan: Scan): ComponentResources {
    const found = [...scan.byPid.values()]
      .filter((stat) => stat.comm === 'cloudflared' && this.proc.ownerUid(stat.pid) === uid)
      .sort((a, b) => a.startTicks - b.startTicks)
      .at(0)
    const missing = PUBLIC_ACCESS === null ? 'off' : 'down'
    return this.component(scan, {
      id: 'cloudflared',
      name: 'cloudflared',
      root: found ?? null,
      state: found === undefined ? missing : 'up',
    })
  }
}
