import type { AnomalyRule } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { inTrouble, meterState, type HostMeter, type MeterState } from './hype'

describe('meterState', () => {
  it.each<[number | null, boolean, MeterState]>([
    [null, false, 'calm'],
    [0, false, 'calm'],
    [49.9, false, 'calm'],
    [50, false, 'flow'],
    [79.9, false, 'flow'],
    [80, false, 'rage'],
    [100, false, 'rage'],
    [140, false, 'rage'],
    [100, true, 'warning'],
    [97, true, 'warning'],
    [12, true, 'warning'],
    [null, true, 'warning'],
  ])('%s%% with trouble %s is %s', (percent, trouble, state) => {
    expect(meterState(percent, trouble)).toBe(state)
  })
})

describe('inTrouble', () => {
  it.each<[HostMeter, AnomalyRule[], boolean]>([
    ['cpu', [], false],
    ['cpu', ['load'], true],
    ['cpu', ['host_memory', 'swap', 'disk', 'hang', 'task_memory', 'down'], false],
    ['memory', [], false],
    ['memory', ['host_memory'], true],
    ['memory', ['swap'], true],
    ['memory', ['load', 'disk', 'hang', 'task_memory', 'down'], false],
  ])('%s with %j broken: %s', (meter, rules, trouble) => {
    expect(inTrouble(meter, rules)).toBe(trouble)
  })

  it('reads a full CPU with healthy memory as hype and pressed memory as a warning', () => {
    const rules: AnomalyRule[] = ['host_memory']
    expect(meterState(100, inTrouble('cpu', rules))).toBe('rage')
    expect(meterState(97, inTrouble('memory', rules))).toBe('warning')
  })
})
