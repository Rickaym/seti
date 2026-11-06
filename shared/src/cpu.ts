import { z } from 'zod'

/** The CPU weight of every agent scope: half of seti.service and the user's own sessions (100). */
export const AGENT_CPU_WEIGHT = 50

/** The smallest ceiling, half a core, in percent of one core. */
export const CPU_QUOTA_MIN = 50

/** An upper bound before the host's own one, nproc x 100, which the server checks. */
const CPU_QUOTA_BOUND = 100 * 1024

/**
 * The CPU ceiling of one agent's process tree, in percent of one core: 300 lets it use three
 * cores at once and the kernel pauses it above that; null sets no ceiling.
 */
export const cpuCapInput = z.object({
  quota_percent: z
    .number()
    .int()
    .min(CPU_QUOTA_MIN, 'at least half a core')
    .max(CPU_QUOTA_BOUND, 'more cores than any host has')
    .nullable(),
})

export type CpuCap = z.infer<typeof cpuCapInput>

/** Three cores by default, or every core on a smaller host. */
export function cpuCapDefaults(maxPercent: number): CpuCap {
  return { quota_percent: Math.min(300, maxPercent) }
}

/** Why a cap does not fit a host with `maxPercent` (nproc x 100), or null when it fits. */
export function cpuCapProblem(cap: CpuCap, maxPercent: number): string | null {
  if (cap.quota_percent === null || cap.quota_percent <= maxPercent) {
    return null
  }
  return `This host has ${coresLabel(maxPercent)}; the cap cannot be above that`
}

/** A cap of its own for one agent, or null to go back to the default. */
export const taskCpuCapInput = z.object({ cap: cpuCapInput.nullable() })

export interface CpuCapSettings {
  cap: CpuCap
  defaults: CpuCap
  /** This host's user manager has the cpu controller, so the scopes hold agents to the cap. */
  enforced: boolean
  /** Null while the defaults apply. */
  updated_at: string | null
  /** Every core of this host, nproc x 100, the highest cap there is. */
  max_percent: number
  /** The CPU weight of every agent scope against Seti's own 100. */
  weight: number
}

export interface TaskCpuCap {
  /** Null when the agent takes the default cap. */
  override: CpuCap | null
  effective: CpuCap
  enforced: boolean
  max_percent: number
}

/** Percent of one core as people read it: 3 cores, 1.5 cores, 1 core. */
export function coresLabel(percent: number): string {
  const cores = Math.round(percent) / 100
  return `${String(cores)} ${cores === 1 ? 'core' : 'cores'}`
}

/** A cap in a few words: 3 cores, or no CPU cap. */
export function cpuCapLabel(cap: CpuCap): string {
  return cap.quota_percent === null ? 'no CPU cap' : coresLabel(cap.quota_percent)
}

/** One line for the agent's system prompt: how many cores its tree gets, and how to use them. */
export function cpuBudgetLine(cap: CpuCap): string | null {
  if (cap.quota_percent === null) {
    return null
  }
  const cores = Math.max(1, Math.floor(cap.quota_percent / 100))
  return (
    `Your process tree gets at most ${coresLabel(cap.quota_percent)} of CPU; more parallel work only waits ` +
    `its turn, so run builds and tests with at most ${String(cores)} ${cores === 1 ? 'worker' : 'workers'}.`
  )
}
