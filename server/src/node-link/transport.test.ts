import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinkEvent } from './events.js'
import { NodeJournal } from './journal.js'
import { LinkPeer } from './link.js'
import { MemoryCursorStore } from './stores.js'
import { LOCAL, scratchDir } from './test-link.js'
import { backoffDelay, dialControlPlane, listenForNodes, type NodeDialer, type NodeServer } from './transport.js'

const cleanups: (() => Promise<unknown>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

async function folder(): Promise<string> {
  const dir = await scratchDir('seti-sock-')
  cleanups.push(async () => fs.rm(dir, { recursive: true, force: true }))
  return dir
}

async function serve(socketPath: string, control: LinkPeer, events: LinkEvent[] = []): Promise<NodeServer> {
  const store = new MemoryCursorStore()
  const server = await listenForNodes({
    path: socketPath,
    local: LOCAL,
    cursorsFor: async () => store.list('node-a'),
    peerFor: () => control,
    onEvent: (event) => events.push(event),
  })
  cleanups.push(async () => server.close())
  return server
}

function dial(socketPath: string, peer: LinkPeer, events: LinkEvent[] = [], local = LOCAL): NodeDialer {
  const dialer = dialControlPlane({
    path: socketPath,
    local,
    node: 'node-a',
    boot: 'boot-1',
    sessions: () => ({}),
    peer,
    backoff: { minMs: 10, maxMs: 40 },
    onEvent: (event) => events.push(event),
  })
  cleanups.push(async () => dialer.stop())
  return dialer
}

describe('backoffDelay', () => {
  it('doubles from 1 s to a 30 s cap with jitter', () => {
    const low = { random: () => 0 }
    const high = { random: () => 1 }
    expect(backoffDelay(0, low)).toBe(1_000)
    expect(backoffDelay(0, high)).toBe(1_250)
    expect(backoffDelay(3, low)).toBe(6_000)
    expect(backoffDelay(3, high)).toBe(10_000)
    expect(backoffDelay(20, low)).toBe(22_500)
    expect(backoffDelay(200, high)).toBe(30_000)
  })
})

describe('unix socket transport', () => {
  it('listens with mode 0600 and refuses links, other files and a live socket', async () => {
    const dir = await folder()
    const socketPath = path.join(dir, 'control.sock')
    await serve(socketPath, new LinkPeer({ pingMs: 0 }))
    expect((await fs.stat(socketPath)).mode & 0o777).toBe(0o600)
    await expect(serve(socketPath, new LinkPeer())).rejects.toThrow(/another process/)

    const link = path.join(dir, 'link.sock')
    await fs.symlink(socketPath, link)
    await expect(serve(link, new LinkPeer())).rejects.toThrow(/refusing/)
    const plain = path.join(dir, 'plain.sock')
    await fs.writeFile(plain, '')
    await expect(serve(plain, new LinkPeer())).rejects.toThrow(/refusing/)
    const open = path.join(dir, 'open')
    await fs.mkdir(open)
    await fs.chmod(open, 0o720)
    await expect(serve(path.join(open, 'c.sock'), new LinkPeer())).rejects.toThrow(/only its owner/)
  })

  it('replaces a stale socket file left by a crash', async () => {
    const socketPath = path.join(await folder(), 'control.sock')
    const stale = net.createServer()
    await new Promise<void>((resolve) => stale.listen(`${socketPath}.old`, resolve))
    await fs.link(`${socketPath}.old`, socketPath)
    await new Promise((resolve) => stale.close(resolve))
    expect((await fs.lstat(socketPath)).isSocket()).toBe(true)
    const events: LinkEvent[] = []
    await serve(socketPath, new LinkPeer({ pingMs: 0 }), events)
    const node = new LinkPeer({ pingMs: 0 })
    dial(socketPath, node)
    await vi.waitFor(() => {
      expect(node.connected).toBe(true)
    })
    expect(events).toContainEqual({ type: 'connected', node: 'node-a', version: 1 })
  })

  it('tells both sides when no version is common', async () => {
    const socketPath = path.join(await folder(), 'control.sock')
    const serverEvents: LinkEvent[] = []
    const nodeEvents: LinkEvent[] = []
    await serve(socketPath, new LinkPeer({ pingMs: 0 }), serverEvents)
    dial(socketPath, new LinkPeer({ pingMs: 0 }), nodeEvents, { protocol: { min: 5, max: 6 }, features: [] })
    await vi.waitFor(() => {
      expect(nodeEvents).toContainEqual({ type: 'incompatible', node: 'node-a' })
      expect(serverEvents).toContainEqual({ type: 'incompatible', node: 'node-a' })
    })
  })

  it('reconnects with a new hello after a drop and delivers the journal exactly once', async () => {
    const dir = await folder()
    const socketPath = path.join(dir, 'control.sock')
    const journal = await NodeJournal.open(path.join(dir, 'journal'))
    cleanups.push(async () => journal.close())
    const agent = await journal.agent('agent-1')
    await agent.append(Array.from({ length: 40 }, (_, index) => ({ type: 'note', body: index })))

    const store = new MemoryCursorStore()
    const commit = store.commit.bind(store)
    let commits = 0
    const control = new LinkPeer({ cursors: store, pingMs: 0 })
    vi.spyOn(store, 'commit').mockImplementation(async (...args) => {
      commits += 1
      if (commits === 4) {
        control.disconnect('test drop')
      }
      return commit(...args)
    })
    const serverEvents: LinkEvent[] = []
    const server = await listenForNodes({
      path: socketPath,
      local: LOCAL,
      cursorsFor: async () => store.list('node-a'),
      peerFor: () => control,
      onEvent: (event) => serverEvents.push(event),
    })
    cleanups.push(async () => server.close())

    const node = new LinkPeer({ journal, journalOptions: { window: 3, batchEntries: 4 }, pingMs: 0 })
    dial(socketPath, node)
    await vi.waitFor(() => {
      expect(serverEvents.filter((event) => event.type === 'connected')).toHaveLength(2)
    })
    await agent.append(Array.from({ length: 5 }, () => ({ type: 'note', body: 'late' })))
    await vi.waitFor(() => {
      expect(store.entries('agent-1').map((entry) => entry.seq)).toEqual(Array.from({ length: 45 }, (_, i) => i + 1))
    })
  })
})
