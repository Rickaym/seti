import type { CpuScope } from '@seti/shared'
import { describe, expect, it } from 'vitest'
import { cpuFill, cpuUseLabel, throttleHint } from './cpu-use'

const scope = (over: Partial<CpuScope> = {}): CpuScope => ({
  unit: 'seti-x-agent-t-1.scope',
  kind: 'agent',
  usage_percent: 140,
  quota_percent: 300,
  weight: 50,
  nr_throttled: 0,
  throttled_usec: 0,
  throttled_now: false,
  ...over,
})

describe('the CPU use of a scope', () => {
  it('reads in cores against the cap, or alone without one', () => {
    expect(cpuUseLabel(scope())).toBe('1.4 of 3 cores')
    expect(cpuUseLabel(scope({ usage_percent: 100, quota_percent: null }))).toBe('1 core, no cap')
    expect(cpuFill(scope({ usage_percent: 150 }))).toBe(50)
    expect(cpuFill(scope({ usage_percent: 320 }))).toBe(100)
    expect(cpuFill(scope({ quota_percent: null }))).toBeNull()
  })

  it('gives a calm hint only while the kernel holds the scope at its cap', () => {
    expect(throttleHint(scope({ nr_throttled: 12, throttled_usec: 900_000 }))).toBeNull()
    expect(throttleHint(scope({ throttled_now: true, quota_percent: null }))).toBeNull()
    expect(throttleHint(scope({ throttled_now: true, nr_throttled: 42, throttled_usec: 3_150_000 }))).toEqual({
      label: 'at its cap of 3 cores',
      detail: 'It wants more CPU than its cap, so it runs slower. Held back 42 times, 3.2 s in all, since it started.',
    })
    expect(throttleHint(scope({ throttled_now: true, nr_throttled: 1, throttled_usec: 90e6 }))?.detail).toContain(
      'Held back 1 time, 1.5 min in all',
    )
  })
})
