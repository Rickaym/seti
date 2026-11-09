import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { inLane, outsideLane, SLOW_LANE_MS } from './task-lane.js'

describe('task lanes', () => {
  it('logs work that holds a lane too long, with where it joined the lane', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await inLane('slow', () => {
        vi.setSystemTime(Date.now() + SLOW_LANE_MS + 2000)
      })
      await inLane('slow', () => undefined)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/^lane: task slow was held 12 s by .*task-lane\.test/)
    } finally {
      vi.useRealTimers()
      warn.mockRestore()
    }
  })

  it('runs work of one task one piece at a time, in the order it came', async () => {
    const steps: string[] = []
    const work = (name: string, ms: number) => async () => {
      steps.push(`${name} start`)
      await sleep(ms)
      steps.push(`${name} end`)
      return name
    }
    const results = await Promise.all([inLane('a', work('first', 20)), inLane('a', work('second', 1))])
    expect(results).toEqual(['first', 'second'])
    expect(steps).toEqual(['first start', 'first end', 'second start', 'second end'])
  })

  it('lets different tasks run side by side', async () => {
    const steps: string[] = []
    await Promise.all([
      inLane('a', async () => {
        steps.push('a start')
        await sleep(20)
        steps.push('a end')
      }),
      inLane('b', async () => {
        steps.push('b start')
        await sleep(1)
        steps.push('b end')
      }),
    ])
    expect(steps).toEqual(['a start', 'b start', 'b end', 'a end'])
  })

  it('runs nested work of the same task in place instead of waiting on itself', async () => {
    const result = await inLane('a', async () => inLane('a', async () => inLane('a', () => 'nested')))
    expect(result).toBe('nested')
  })

  it('queues detached work that starts outside the lane, and timers that fire after the holder', async () => {
    const steps: string[] = []
    let late: Promise<void> = Promise.resolve()
    await inLane('a', async () => {
      steps.push('holder')
      void outsideLane(async () =>
        inLane('a', () => {
          steps.push('detached')
        }),
      )
      late = sleep(20).then(async () =>
        inLane('a', () => {
          steps.push('late')
        }),
      )
      await sleep(5)
      steps.push('holder end')
    })
    await late
    expect(steps).toEqual(['holder', 'holder end', 'detached', 'late'])
  })

  it('keeps the lane going after a piece of work fails', async () => {
    const failed = inLane('a', () => {
      throw new Error('boom')
    })
    await expect(failed).rejects.toThrow('boom')
    await expect(inLane('a', () => 'after')).resolves.toBe('after')
  })
})
