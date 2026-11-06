import { describe, expect, it, vi } from 'vitest'
import { inBackground, onShutdown, shutdown } from './background.js'

describe('background work', () => {
  it('logs failures, waits for running work before stopping and drops work started later', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const order: string[] = []
    let finish: () => void = () => undefined
    inBackground('slow', async () => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      order.push('slow')
    })
    inBackground('failing', async () => Promise.reject(new Error('boom')))
    onShutdown(async () => {
      order.push('stopped')
      return Promise.resolve()
    })

    const stopping = shutdown()
    inBackground('late', async () => {
      order.push('late')
      return Promise.resolve()
    })
    finish()
    await stopping

    expect(order).toEqual(['slow', 'stopped'])
    expect(write).toHaveBeenCalledWith('failing: boom\n')
    write.mockRestore()
  })
})
