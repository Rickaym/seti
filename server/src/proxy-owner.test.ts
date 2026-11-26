import type { ProxyGrant, Task } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import {
  proxiesRunBy,
  proxyAwsToken,
  proxyCa,
  proxyConnections,
  proxyGone,
  modelProxyHere,
  proxyHere,
  sshAgentHere,
  sshKeysChanged,
} from './proxy-owner.js'

const task = { id: 'agent' } as Task
const grant: ProxyGrant = { login: null, anthropic: true, connections: [], mcp: [], deniedConnectors: [], caHosts: [] }

describe('the owner of an agent egress proxy', () => {
  it('runs the proxy here until another process runs them, then has that process open and close it', async () => {
    const start = vi.fn(async () => Promise.resolve())
    const stop = vi.fn(async () => Promise.resolve())
    await proxyHere(task.id, grant, start)
    await proxyGone(task.id, stop)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(await proxyAwsToken(task.id, () => 'here')).toBe('here')
    expect(await proxyConnections(task.id, [], async () => Promise.resolve(true))).toBe(true)
    expect(
      await proxyCa(
        async () => Promise.resolve('loaded'),
        () => 'located',
      ),
    ).toBe('loaded')

    const owner = {
      open: vi.fn(async () => Promise.resolve()),
      openModel: vi.fn(async () => Promise.resolve()),
      close: vi.fn(async () => Promise.resolve()),
      connections: vi.fn(async () => Promise.resolve(false)),
      awsToken: vi.fn(async () => Promise.resolve('node')),
      sshOpen: vi.fn(async () => Promise.resolve()),
      sshReload: vi.fn(async () => Promise.resolve()),
    }
    proxiesRunBy(owner)
    await proxyHere(task.id, grant, start)
    await proxyGone(task.id, stop)
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(owner.open).toHaveBeenCalledWith('agent', grant)
    await modelProxyHere(task.id, { login: 'login', key: null }, start)
    expect(owner.openModel).toHaveBeenCalledWith('agent', { login: 'login', key: null })
    expect(owner.close).toHaveBeenCalledWith('agent')
    expect(await proxyAwsToken(task.id, () => 'here')).toBe('node')
    expect(await proxyConnections(task.id, [], async () => Promise.resolve(true))).toBe(false)
    expect(owner.connections).toHaveBeenCalledWith('agent', [])
    await sshAgentHere(task.id, start)
    await sshKeysChanged()
    expect(start).toHaveBeenCalledTimes(1)
    expect(owner.sshOpen).toHaveBeenCalledWith('agent')
    expect(owner.sshReload).toHaveBeenCalledTimes(1)
    const load = vi.fn(async () => Promise.resolve('loaded'))
    expect(await proxyCa(load, () => 'located')).toBe('located')
    expect(load).not.toHaveBeenCalled()
  })
})
