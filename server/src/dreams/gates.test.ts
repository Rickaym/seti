import fs from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { diskGate, loadGate, planGate } from './gates.js'

const window = (key: string, utilization: number) => ({ key, label: key, utilization, resets_at: null })

describe('dream gates', () => {
  it('holds dreams back past 60% of the 5-hour window or 85% of a weekly one', () => {
    expect(planGate([window('five_hour', 59), window('seven_day', 84)])).toBeNull()
    expect(planGate([window('five_hour', 61)])).toMatch(/5-hour window is at 61%/)
    expect(planGate([window('seven_day_sonnet', 90)])).toMatch(/plan limit/)
    expect(planGate([])).toBeNull()
  })

  it('holds dreams back when the load passes three quarters of the cores', () => {
    expect(loadGate(11.9, 16)).toBeNull()
    expect(loadGate(12, 16)).toMatch(/host busy/)
  })

  it('checks every disk it is given, the root and the data disk, and needs 5 GB on each', async () => {
    const free = { '/': 9 * 1024 ** 3, '/data': 2 * 1024 ** 3 }
    const statfs = vi
      .spyOn(fs, 'statfs')
      .mockImplementation(async (path) =>
        Promise.resolve({ bavail: free[String(path) as keyof typeof free], bsize: 1 } as Awaited<
          ReturnType<typeof fs.statfs>
        >),
      )
    expect(await diskGate(['/'])).toBeNull()
    expect(await diskGate(['/', '/data'])).toMatch(/less than 5 GB free on \/data/)
    statfs.mockRestore()
  })
})
