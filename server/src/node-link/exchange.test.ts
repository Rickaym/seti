import { duplexPair } from 'node:stream'
import type { NodeMessageOf } from '@seti/shared'
import { describe, expect, it, vi } from 'vitest'
import { LinkConnection } from './connection.js'
import type { LinkEvent } from './events.js'
import { OfflineError, type AskReply } from './exchange.js'
import { encodeFrame } from './frames.js'
import { LinkPeer } from './link.js'
import { MemoryReplyStore } from './stores.js'
import { linkPeers } from './test-link.js'

function deferred<T>() {
  let settle: (value: T) => void = () => undefined
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, settle }
}

describe('commands', () => {
  it('runs a command once however often its id is sent, and returns the first result', async () => {
    let runs = 0
    const node = new LinkPeer({
      pingMs: 0,
      handlers: {
        command: async (message) => {
          runs += 1
          return Promise.resolve({ ran: message.kind, runs })
        },
      },
    })
    const control = new LinkPeer({ pingMs: 0 })
    await linkPeers(node, control)
    const command = { id: 'prompt-41', kind: 'turn.send', agent: 'agent-1', body: { text: 'hi' } }
    const [first, second] = await Promise.all([control.command(command), control.command(command)])
    const third = await control.command(command)
    expect(runs).toBe(1)
    expect(first).toEqual({ ok: true, body: { ran: 'turn.send', runs: 1 } })
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('sends a command again after a reconnect and gets the stored result, not a second run', async () => {
    const gate = deferred<string>()
    const handler = vi.fn(async () => gate.promise)
    const node = new LinkPeer({ pingMs: 0, handlers: { command: handler } })
    const control = new LinkPeer({ pingMs: 0 })
    const first = await linkPeers(node, control)
    const result = control.command({ id: 'prompt-7', kind: 'turn.stop', body: null })
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
    })
    first.drop()
    await first.controlClosed
    gate.settle('stopped')
    await linkPeers(node, control)
    await expect(result).resolves.toEqual({ ok: true, body: 'stopped' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('reports a failed command and a side that takes no commands', async () => {
    const node = new LinkPeer({ pingMs: 0, handlers: { command: async () => Promise.reject(new Error('no session')) } })
    const control = new LinkPeer({ pingMs: 0 })
    await linkPeers(node, control)
    await expect(control.command({ id: 'c1', kind: 'turn.send', body: {} })).resolves.toEqual({
      ok: false,
      error: 'no session',
    })
    await expect(node.command({ id: 'c2', kind: 'x', body: {} })).resolves.toMatchObject({ ok: false })
  })
})

describe('asks', () => {
  it('gives a retried ask the stored answer without asking again', async () => {
    const gate = deferred<AskReply>()
    const handler = vi.fn(async (_message: NodeMessageOf<'ask'>) => gate.promise)
    const answers = new MemoryReplyStore<AskReply>()
    const node = new LinkPeer({ pingMs: 0 })
    const control = new LinkPeer({ pingMs: 0, askAnswers: answers, handlers: { ask: handler } })
    const first = await linkPeers(node, control)
    const answer = node.ask({ id: 'ask-1', kind: 'tool.call', agent: 'agent-1', body: { tool: 'notify' } })
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1)
    })
    first.drop()
    await first.nodeClosed
    gate.settle({ kind: 'answer', body: { ok: 1 } })
    await vi.waitFor(async () => {
      expect(await answers.get('ask-1')).toEqual({ kind: 'answer', body: { ok: 1 } })
    })
    await linkPeers(node, control)
    await expect(answer).resolves.toEqual({ kind: 'answer', body: { ok: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('passes on a cancel, and an abort stops the answering handler', async () => {
    let aborted = false
    const control = new LinkPeer({
      pingMs: 0,
      handlers: {
        ask: async (message, signal) => {
          if (message.kind === 'refuse') {
            return Promise.resolve({ kind: 'cancel' })
          }
          return new Promise<AskReply>((resolve) => {
            signal.addEventListener('abort', () => {
              aborted = true
              resolve({ kind: 'answer', body: 'too late' })
            })
          })
        },
      },
    })
    const node = new LinkPeer({ pingMs: 0 })
    await linkPeers(node, control)
    await expect(node.ask({ id: 'a1', kind: 'refuse', agent: 'x', body: null })).resolves.toEqual({ kind: 'cancel' })
    const abort = new AbortController()
    const pending = node.ask({ id: 'a2', kind: 'wait', agent: 'x', body: null }, abort.signal)
    abort.abort()
    await expect(pending).resolves.toEqual({ kind: 'aborted' })
    await vi.waitFor(() => {
      expect(aborted).toBe(true)
    })
  })
})

describe('requests', () => {
  it('answer while connected and fail fast when the link is down', async () => {
    const node = new LinkPeer({
      pingMs: 0,
      handlers: { request: async (message) => Promise.resolve({ listed: message.body }) },
    })
    const control = new LinkPeer({ pingMs: 0 })
    await expect(control.request({ kind: 'files.list', body: '.' })).rejects.toBeInstanceOf(OfflineError)
    const linked = await linkPeers(node, control)
    expect(control.connected).toBe(true)
    await expect(control.request({ kind: 'files.list', agent: 'a', body: '.' })).resolves.toEqual({
      ok: true,
      body: { listed: '.' },
    })
    const hanging = new LinkPeer({ pingMs: 0, handlers: { request: async () => new Promise(() => undefined) } })
    linked.drop()
    await linked.controlClosed
    const second = await linkPeers(hanging, control)
    const open = control.request({ kind: 'probe.run', body: null })
    second.drop()
    await expect(open).rejects.toBeInstanceOf(OfflineError)
  })
})

describe('state, bulk and pings', () => {
  it('applies only newer state, and sends the latest again after a reconnect', async () => {
    const seen: unknown[] = []
    const node = new LinkPeer({ pingMs: 0, handlers: { state: (message) => seen.push(message.body) } })
    const control = new LinkPeer({ pingMs: 0 })
    control.setState({ agent: 'a', version: 1, body: 'one' })
    const first = await linkPeers(node, control)
    expect(node.features).toEqual(['bulk'])
    control.setState({ agent: 'a', version: 2, body: 'two' })
    control.setState({ version: 1, body: 'node-wide' })
    await vi.waitFor(() => {
      expect(seen).toEqual(['one', 'two', 'node-wide'])
    })
    first.drop()
    await first.controlClosed
    control.setState({ agent: 'a', version: 3, body: 'three' })
    await linkPeers(node, control)
    await vi.waitFor(() => {
      expect(seen).toEqual(['one', 'two', 'node-wide', 'three'])
    })
  })

  it('delivers bulk bytes and drops them while the link is down', async () => {
    const received: string[] = []
    const control = new LinkPeer({
      pingMs: 0,
      handlers: {
        bulk: (stream, offset, data) => received.push(`${String(stream)}@${String(offset)}:${data.toString()}`),
      },
    })
    const node = new LinkPeer({ pingMs: 0 })
    node.sendBulk(1, 0, Buffer.from('lost'))
    await linkPeers(node, control)
    node.sendBulk(2, 10, Buffer.from('tail'))
    await vi.waitFor(() => {
      expect(received).toEqual(['2@10:tail'])
    })
  })

  it('answers pings, closes a silent connection and reports unknown types', async () => {
    const events: LinkEvent[] = []
    const control = new LinkPeer({ pingMs: 15, onEvent: (event) => events.push(event) })
    const node = new LinkPeer({ pingMs: 0 })
    const linked = await linkPeers(node, control)
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(control.connected).toBe(true)
    linked.drop()
    await linked.controlClosed

    const [mute, other] = duplexPair()
    mute.resume()
    mute.on('end', () => mute.end())
    const closed = control.attach(new LinkConnection(other, { version: 1 }), { version: 1, features: [] })
    mute.write(encodeFrame({ kind: 'json', text: '{"v":1,"type":"warp","id":"w1"}' }))
    await expect(closed).resolves.toEqual({ kind: 'local', reason: 'no message for three pings' })
    expect(events).toContainEqual({ type: 'unsupported', messageType: 'warp' })
  })

  it('disconnects on request and lets a newer connection replace an older one', async () => {
    const node = new LinkPeer({ pingMs: 0 })
    const control = new LinkPeer({ pingMs: 0 })
    const first = await linkPeers(node, control)
    const second = await linkPeers(node, control)
    await expect(first.controlClosed).resolves.toEqual({ kind: 'local', reason: 'replaced by a newer connection' })
    expect(control.connected).toBe(true)
    control.disconnect('moving the agent')
    await expect(second.controlClosed).resolves.toEqual({ kind: 'local', reason: 'moving the agent' })
  })
})
