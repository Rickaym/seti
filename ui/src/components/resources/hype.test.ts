import type { AnomalyRule } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { inTrouble, meterState, powerBar, type HostMeter, type MeterState, type Power, type PowerReading } from './hype'

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
})

describe('powerBar', () => {
  const LOAD = 'run queue overloaded'
  const MEMORY = 'memory almost used up'
  const SWAP = 'swap almost full'
  const none: string[] = []

  it.each<[string, PowerReading, Power]>([
    ['both low', { cpu: 12, memory: 30, rules: [] }, { state: 'calm', percent: 30, driver: 'memory', reasons: none }],
    [
      'both under flow',
      { cpu: 49.9, memory: 49.9, rules: [] },
      { state: 'calm', percent: 49.9, driver: 'cpu', reasons: none },
    ],
    [
      'CPU flowing only',
      { cpu: 63, memory: 20, rules: [] },
      { state: 'flow', percent: 63, driver: 'cpu', reasons: none },
    ],
    [
      'memory flowing only',
      { cpu: 20, memory: 58, rules: [] },
      { state: 'flow', percent: 58, driver: 'memory', reasons: none },
    ],
    ['CPU high only', { cpu: 87, memory: 42, rules: [] }, { state: 'rage', percent: 87, driver: 'cpu', reasons: none }],
    [
      'memory high only',
      { cpu: 14, memory: 86, rules: [] },
      { state: 'rage', percent: 86, driver: 'memory', reasons: none },
    ],
    [
      'CPU high, memory flowing',
      { cpu: 100, memory: 62, rules: [] },
      { state: 'rage', percent: 100, driver: 'cpu', reasons: none },
    ],
    ['both high', { cpu: 96, memory: 88, rules: [] }, { state: 'rage', percent: 96, driver: 'cpu', reasons: none }],
    [
      'both high and equal',
      { cpu: 90, memory: 90, rules: [] },
      { state: 'rage', percent: 90, driver: 'cpu', reasons: none },
    ],
    [
      'CPU unknown, memory low',
      { cpu: null, memory: 30, rules: [] },
      { state: 'calm', percent: 30, driver: 'memory', reasons: none },
    ],
    [
      'CPU unknown, memory high',
      { cpu: null, memory: 85, rules: [] },
      { state: 'rage', percent: 85, driver: 'memory', reasons: none },
    ],
    [
      'both unknown',
      { cpu: null, memory: null, rules: [] },
      { state: 'calm', percent: null, driver: 'cpu', reasons: none },
    ],
    [
      'CPU warning',
      { cpu: 100, memory: 40, rules: ['load'] },
      { state: 'warning', percent: 100, driver: 'cpu', reasons: [LOAD] },
    ],
    [
      'CPU warning under busier memory',
      { cpu: 70, memory: 85, rules: ['load'] },
      { state: 'warning', percent: 70, driver: 'cpu', reasons: [LOAD] },
    ],
    [
      'memory warning beside a full CPU',
      { cpu: 100, memory: 97, rules: ['host_memory'] },
      { state: 'warning', percent: 97, driver: 'memory', reasons: [MEMORY] },
    ],
    [
      'swap warning on a quiet host',
      { cpu: 12, memory: 55, rules: ['swap'] },
      { state: 'warning', percent: 55, driver: 'memory', reasons: [SWAP] },
    ],
    [
      'memory and swap warning',
      { cpu: 30, memory: 95, rules: ['swap', 'host_memory'] },
      { state: 'warning', percent: 95, driver: 'memory', reasons: [MEMORY, SWAP] },
    ],
    [
      'both warning',
      { cpu: 100, memory: 97, rules: ['host_memory', 'load'] },
      { state: 'warning', percent: 100, driver: 'cpu', reasons: [LOAD, MEMORY] },
    ],
    [
      'both warning, memory higher',
      { cpu: 60, memory: 97, rules: ['load', 'swap'] },
      { state: 'warning', percent: 97, driver: 'memory', reasons: [LOAD, SWAP] },
    ],
    [
      'other rules broken, CPU high',
      { cpu: 87, memory: 42, rules: ['disk', 'hang', 'task_memory', 'down'] },
      { state: 'rage', percent: 87, driver: 'cpu', reasons: none },
    ],
  ])('%s', (_name, reading, power) => {
    expect(powerBar(reading)).toEqual(power)
  })
})
