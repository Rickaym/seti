import { describe, expect, it, vi } from 'vitest'
import { proxiesServedBy, proxyHere } from './proxy-owner.js'

describe('the owner of an agent egress proxy', () => {
  it('starts no second proxy for an agent another process serves, and starts one for the rest', async () => {
    proxiesServedBy(async (taskId) => Promise.resolve(taskId === 'served'))
    const start = vi.fn(async () => Promise.resolve())
    expect(await proxyHere('served', start)).toBe(false)
    expect(start).not.toHaveBeenCalled()
    expect(await proxyHere('alone', start)).toBe(true)
    expect(start).toHaveBeenCalledTimes(1)
  })
})
