import type { Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { proxiesRunBy, proxyGone, proxyHere } from './proxy-owner.js'

const task = { id: 'agent' } as Task

describe('the owner of an agent egress proxy', () => {
  it('runs the proxy here until another process runs them, then has that process open and close it', async () => {
    const start = vi.fn(async () => Promise.resolve())
    const stop = vi.fn(async () => Promise.resolve())
    await proxyHere(task, start)
    await proxyGone(task.id, stop)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)

    const owner = { open: vi.fn(async () => Promise.resolve()), close: vi.fn(async () => Promise.resolve()) }
    proxiesRunBy(owner)
    await proxyHere(task, start)
    await proxyGone(task.id, stop)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(owner.open).toHaveBeenCalledWith(task)
    expect(owner.close).toHaveBeenCalledWith('agent')
  })
})
