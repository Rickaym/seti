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

const REASON: Partial<Record<AnomalyRule, string>> = {
  load: 'run queue overloaded',
  host_memory: 'memory almost used up',
  swap: 'swap almost full',
}

const METERS: readonly HostMeter[] = ['cpu', 'memory']

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

export interface PowerReading {
  cpu: number | null
  memory: number | null
  rules: readonly AnomalyRule[]
}

export interface Power {
  state: MeterState
  /** The reading the bar fills to: the driver's. */
  percent: number | null
  /** The resource the bar follows: the one in trouble, else the busier, CPU on a tie. */
  driver: HostMeter
  /** Why the bar warns, one phrase per broken rule; empty unless the state is a warning. */
  reasons: string[]
}

/**
 * CPU and memory as one bar: it is as lively as the busier of the two, so either one well used
 * lights it up, and trouble with either holds it still as a warning.
 */
export function powerBar({ cpu, memory, rules }: PowerReading): Power {
  const reading = { cpu, memory }
  const troubled = METERS.filter((meter) => inTrouble(meter, rules))
  const candidates = troubled.length > 0 ? troubled : METERS
  const driver = candidates.reduce((top, meter) => ((reading[meter] ?? -1) > (reading[top] ?? -1) ? meter : top))
  const percent = reading[driver]
  const reasons = METERS.flatMap((meter) => TROUBLE[meter])
    .filter((rule) => rules.includes(rule))
    .flatMap((rule) => REASON[rule] ?? [])
  return { state: meterState(percent, troubled.length > 0), percent, driver, reasons }
}
