import { describe, expect, it } from 'vitest'
import { parseCpuForm, sameCpuForm, toCpuForm } from './cpu-cap-form'

const EIGHT_CORES = 800

describe('the CPU cap form', () => {
  it('shows a cap in cores and an off cap as a toggle with three cores ready', () => {
    expect(toCpuForm({ quota_percent: 300 })).toEqual({ limited: true, cores: '3' })
    expect(toCpuForm({ quota_percent: 150 })).toEqual({ limited: true, cores: '1.5' })
    expect(toCpuForm({ quota_percent: null })).toEqual({ limited: false, cores: '3' })
  })

  it('turns cores into percent of one core, and off into no cap', () => {
    expect(parseCpuForm({ limited: true, cores: '2.5' }, EIGHT_CORES)).toEqual({ cap: { quota_percent: 250 } })
    expect(parseCpuForm({ limited: true, cores: '0.5' }, EIGHT_CORES)).toEqual({ cap: { quota_percent: 50 } })
    expect(parseCpuForm({ limited: true, cores: '8' }, EIGHT_CORES)).toEqual({ cap: { quota_percent: 800 } })
    expect(parseCpuForm({ limited: false, cores: 'junk' }, EIGHT_CORES)).toEqual({ cap: { quota_percent: null } })
  })

  it('refuses less than half a core, more cores than the host has, and no number', () => {
    expect(parseCpuForm({ limited: true, cores: '0.4' }, EIGHT_CORES)).toEqual({
      error: 'The cap is at least half a core',
    })
    expect(parseCpuForm({ limited: true, cores: '9' }, EIGHT_CORES)).toEqual({
      error: 'This host has 8 cores; the cap cannot be above that',
    })
    expect(parseCpuForm({ limited: true, cores: ' ' }, EIGHT_CORES)).toEqual({
      error: 'Give the cap as a number of cores',
    })
  })

  it('compares forms by what they mean', () => {
    expect(sameCpuForm({ limited: true, cores: '3' }, { limited: true, cores: '3.0' })).toBe(true)
    expect(sameCpuForm({ limited: false, cores: '2' }, { limited: false, cores: '3' })).toBe(true)
    expect(sameCpuForm({ limited: true, cores: '2' }, { limited: false, cores: '2' })).toBe(false)
  })
})
