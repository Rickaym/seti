import { AGENT_CPU_WEIGHT, type CpuCap } from '@seti/shared'

/** The window a first look at a scope's CPU use measures over. */
const WINDOW_MS = 250
/** A reading older than this is too old to measure from; a fresh window starts instead. */
const STALE_MS = 10_000
/** A reading younger than this is too close to measure from. */
const MIN_SPAN_MS = 100

/**
 * The systemd properties that hold a scope to `cap`: a share below Seti's own under contention,
 * and a ceiling of `quota_percent` of one core. An empty CPUQuota= takes a ceiling away.
 */
export function cpuProperties(cap: CpuCap): string[] {
  const quota = cap.quota_percent === null ? '' : `${String(cap.quota_percent)}%`
  return [`CPUWeight=${String(AGENT_CPU_WEIGHT)}`, `CPUQuota=${quota}`]
}

/** The counters of a cgroup's cpu.stat that Seti reads. */
export interface CpuStat {
  usage_usec: number
  nr_throttled: number
  throttled_usec: number
}

export function parseCpuStat(text: string): CpuStat {
  const counts = new Map(
    text
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key ?? '', Number(value)] as const),
  )
  const count = (key: string) => {
    const value = counts.get(key) ?? 0
    return Number.isFinite(value) ? value : 0
  }
  return {
    usage_usec: count('usage_usec'),
    nr_throttled: count('nr_throttled'),
    throttled_usec: count('throttled_usec'),
  }
}

/** A cpu.stat reading and when Seti took it, in ms. */
export interface CpuReading {
  stat: CpuStat
  at: number
}

/** Percent of one core used between two readings, and whether the kernel paused it in between. */
export function cpuUsage(before: CpuReading, after: CpuReading): { usage_percent: number; throttled_now: boolean } {
  const spanUsec = Math.max(1, after.at - before.at) * 1000
  const used = Math.max(0, after.stat.usage_usec - before.stat.usage_usec)
  return {
    usage_percent: Math.round((1000 * used) / spanUsec) / 10,
    throttled_now: after.stat.nr_throttled > before.stat.nr_throttled,
  }
}

/** Measures each scope's CPU use from its previous reading, or over a short window at first. */
export class CpuSampler {
  private readonly last = new Map<string, CpuReading>()
  private readonly read: (dir: string) => CpuStat | null
  private readonly windowMs: number
  private readonly clock: () => number

  constructor(read: (dir: string) => CpuStat | null, windowMs = WINDOW_MS, clock: () => number = Date.now) {
    this.read = read
    this.windowMs = windowMs
    this.clock = clock
  }

  private reading(dir: string): CpuReading | null {
    const stat = this.read(dir)
    return stat === null ? null : { stat, at: this.clock() }
  }

  async sample(
    unit: string,
    dir: string,
  ): Promise<(CpuStat & { usage_percent: number; throttled_now: boolean }) | null> {
    let before = this.last.get(unit) ?? null
    const age = before === null ? Infinity : this.clock() - before.at
    if (before === null || age > STALE_MS || age < MIN_SPAN_MS) {
      before = this.reading(dir)
      await new Promise((resolve) => setTimeout(resolve, this.windowMs))
    }
    const after = this.reading(dir)
    if (before === null || after === null) {
      return null
    }
    this.last.set(unit, after)
    return { ...after.stat, ...cpuUsage(before, after) }
  }

  /** Drops the readings of scopes that are gone. */
  keep(units: ReadonlySet<string>): void {
    for (const unit of this.last.keys()) {
      if (!units.has(unit)) {
        this.last.delete(unit)
      }
    }
  }
}
