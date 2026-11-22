import type { AnomalyRule } from '@seti/shared'

/** How a CPU or memory meter looks: busier is livelier, and only real trouble is a warning. */
export type MeterState = 'calm' | 'flow' | 'rage' | 'warning'

export type HostMeter = 'cpu' | 'memory'

/** From this share of the machine in use the fill starts to flow. */
const FLOW_PERCENT = 50
/** From this share the fill rages: every hue, moving fast. */
const RAGE_PERCENT = 80

/**
 * The anomaly rules that make a reading trouble instead of good use: a run queue twice the CPUs
 * for CPU; memory with under a tenth still available, or swap nearly full, for memory.
 */
const TROUBLE: Record<HostMeter, readonly AnomalyRule[]> = {
  cpu: ['load'],
  memory: ['host_memory', 'swap'],
}

export const inTrouble = (meter: HostMeter, rules: readonly AnomalyRule[]): boolean =>
  TROUBLE[meter].some((rule) => rules.includes(rule))

/** Trouble outranks every level of use; an unknown reading is calm. */
export function meterState(percent: number | null, trouble: boolean): MeterState {
  if (trouble) {
    return 'warning'
  }
  if (percent === null || percent < FLOW_PERCENT) {
    return 'calm'
  }
  return percent < RAGE_PERCENT ? 'flow' : 'rage'
}
