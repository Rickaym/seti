import fs from 'node:fs'
import type http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { NODE_ASKS, type HelloFrame, type JournalEntry, type NodeCommandType } from '@seti/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { ValueLate } from '../egress-answers.js'
import { NodeClient, type NodeClientEnd } from '../node-client.js'
import { nodeLink, reachControl, serveNode, type ControlEnd } from '../node-link.js'
import type { NodeCursor } from '../store/node-cursors.js'
import { askValue } from '../value-wait.js'
import { NodeService, type NodeSessions } from './service.js'
import { checkNodeSocket, listenNode } from './socket.js'

const AGENT = 'task-1'
const note = (error: string): JournalEntry => ({ type: 'note', error })
const uid = process.getuid?.() ?? -1

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup()
  }
})

/** A node whose one session the test drives, listening on a socket in a scratch folder. */
async function startNode(commands: Partial<Record<NodeCommandType, (body: unknown) => Promise<unknown>>> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seti-node-'))
  const socket = path.join(dir, 'run', 'node.sock')
  const cut = vi.fn(async () => Promise.resolve())
  const sessions: NodeSessions = {
    command: async (type, body) => {
      const run = commands[type]
      if (run === undefined) {
        throw new Error(`No ${type} here`)
      }
      return run(body)
    },
    snapshot: () => [],
    cut,
  }
  const service = new NodeService(sessions, 'test')
  const server: http.Server = await listenNode(socket, (control) => {
    service.attach(control)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { socket, service, cut }
}

/** A control plane that records what it applies, keeping its cursors where a restart finds them. */
function controlPlane(
  socket: string,
  kept: Map<string, NodeCursor>,
  applied: string[],
  end: Partial<NodeClientEnd> = {},
) {
  const fresh = vi.fn(async () => Promise.resolve(() => undefined))
  const client = new NodeClient({
    socket,
    check: (at) => {
      checkNodeSocket(at, uid)
    },
    local: true,
    journal: async (agent, entry) => {
      applied.push(`${agent}:${entry.type === 'note' ? entry.error : entry.type}`)
      return Promise.resolve()
    },
    answer: async () => Promise.resolve({}),
    cursors: {
      list: async () => Promise.resolve([...kept.values()]),
      save: async (cursor) => {
        kept.set(cursor.agent, cursor)
        return Promise.resolve()
      },
    },
    fresh,
    took: () => undefined,
    taking: async () => Promise.resolve(),
    stopping: async () => Promise.resolve(),
    ...end,
  })
  cleanups.push(() => {
    client.close()
  })
  return { client, fresh }
}

/** Waits until the node took the control plane: a command reaches the node. */
async function welcomed(client: NodeClient): Promise<void> {
  await vi.waitFor(async () => expect(client.command('sessions.view', {})).rejects.toThrow(/No sessions.view here/))
}

describe('the node over its socket', () => {
  it('finishes a turn while the control plane restarts, and its entries arrive once, in order', async () => {
    const node = await startNode({ 'turn.send': async () => Promise.resolve({ outcome: 'started' }) })
    const kept = new Map<string, NodeCursor>()
    const applied: string[] = []
    const first = controlPlane(node.socket, kept, applied)
    await first.client.start()
    await welcomed(first.client)
    expect(first.fresh).toHaveBeenCalledTimes(1)
    await expect(first.client.command('turn.send', {})).resolves.toEqual({ outcome: 'started' })
    await node.service.control.journal(AGENT, { type: 'turn.started' })
    await node.service.control.journal(AGENT, note('n1'))
    await vi.waitFor(() => {
      expect(applied).toEqual([`${AGENT}:turn.started`, `${AGENT}:n1`])
    })
    first.client.close()
    await node.service.control.journal(AGENT, note('n2'))
    await node.service.control.journal(AGENT, { type: 'turn.ended', status: 'idle', error: null })
    const second = controlPlane(node.socket, kept, applied)
    await second.client.start()
    await vi.waitFor(
      () => {
        expect(applied).toEqual([`${AGENT}:turn.started`, `${AGENT}:n1`, `${AGENT}:n2`, `${AGENT}:turn.ended`])
      },
      { timeout: 5000 },
    )
    expect(second.fresh).not.toHaveBeenCalled()
  })

  it('answers a command once the control plane applied what the node reported before it', async () => {
    const reports: { to: ((entry: JournalEntry) => Promise<void>) | null } = { to: null }
    const node = await startNode({
      'turn.send': async () => {
        await reports.to?.({ type: 'turn.started' })
        return { outcome: 'started' }
      },
    })
    reports.to = async (entry) => node.service.control.journal(AGENT, entry)
    const applying = { arrived: false, release: () => undefined as unknown }
    const gate = new Promise<void>((resolve) => {
      applying.release = resolve
    })
    const applied: string[] = []
    const journal = async (agent: string, entry: JournalEntry) => {
      applying.arrived = true
      await gate
      applied.push(`${agent}:${entry.type}`)
    }
    const control = controlPlane(node.socket, new Map(), applied, { journal })
    await control.client.start()
    await welcomed(control.client)
    let answered = false
    const sent = control.client.command('turn.send', { agent: AGENT }).then((answer) => {
      answered = true
      return answer
    })
    await vi.waitFor(() => {
      expect(applying.arrived).toBe(true)
    })
    expect(answered).toBe(false)
    applying.release()
    await expect(sent).resolves.toEqual({ outcome: 'started' })
    expect(applied).toEqual([`${AGENT}:turn.started`])
  })

  it('lets work an entry starts command the node without waiting for the entries after it', async () => {
    const reports: { to: ((entry: JournalEntry) => Promise<void>) | null } = { to: null }
    const node = await startNode({
      'turn.send': async () => {
        await reports.to?.({ type: 'turn.started' })
        return { outcome: 'started' }
      },
    })
    reports.to = async (entry) => node.service.control.journal(AGENT, entry)
    const applied: string[] = []
    const plane: { client: NodeClient | null } = { client: null }
    const journal = async (agent: string, entry: JournalEntry) => {
      applied.push(`${agent}:${entry.type}`)
      if (entry.type === 'turn.ended') {
        await plane.client?.command('turn.send', { agent })
      }
    }
    const control = controlPlane(node.socket, new Map(), applied, { journal })
    plane.client = control.client
    await control.client.start()
    await welcomed(control.client)
    await node.service.control.journal(AGENT, { type: 'turn.ended', status: 'idle', error: null })
    await vi.waitFor(() => {
      expect(applied).toEqual([`${AGENT}:turn.ended`, `${AGENT}:turn.started`])
    })
  })

  it('names the asks it waits on as it connects, and answers each once a control plane is there', async () => {
    const node = await startNode()
    const answer = vi.fn(async () => Promise.resolve({ promptId: 4, text: 'hello' }))
    const asked = node.service.control.ask(
      AGENT,
      'prompt.open',
      { next: {}, queued: false },
      new AbortController().signal,
    )
    const taking = vi.fn(async (_hello: HelloFrame) => Promise.resolve())
    const control = controlPlane(node.socket, new Map(), [], { answer, taking })
    await control.client.start()
    await expect(asked).resolves.toEqual({ promptId: 4, text: 'hello' })
    expect(answer).toHaveBeenCalledTimes(1)
    const [[askId]] = answer.mock.calls as unknown as [[{ id: string }]]
    expect(taking.mock.calls[0]?.[0].asks).toEqual([askId.id])
  })

  it('has the control plane record the turns of a stopping node before it cuts them', async () => {
    const node = await startNode()
    const order: string[] = []
    node.cut.mockImplementation(async () => {
      order.push('cut')
      return Promise.resolve()
    })
    const stopping = vi.fn(async () => {
      order.push('recorded')
      return Promise.resolve()
    })
    const control = controlPlane(node.socket, new Map(), [], { stopping })
    await control.client.start()
    await welcomed(control.client)
    await node.service.stop(2000)
    expect(order).toEqual(['recorded', 'cut'])
  })

  it('stops taking the node once a cursor cannot be kept, and says Seti needs a restart', async () => {
    const node = await startNode()
    const applied: string[] = []
    const save = async () => Promise.reject(new Error('the database is gone'))
    const control = controlPlane(node.socket, new Map(), applied, {
      cursors: { list: async () => Promise.resolve([]), save },
    })
    await control.client.start()
    await welcomed(control.client)
    await node.service.control.journal(AGENT, note('n1'))
    await vi.waitFor(async () =>
      expect(control.client.command('quiet.restart', { agent: AGENT, at: null })).rejects.toThrow(/needs a restart/),
    )
    expect(applied).toEqual([])
  })

  it('refuses commands while the node is not connected', async () => {
    const control = controlPlane(path.join(os.tmpdir(), 'seti-no-node', 'node.sock'), new Map(), [])
    await control.client.start(0)
    await expect(control.client.command('quiet.restart', { agent: AGENT, at: null })).rejects.toThrow(/not connected/)
  })

  it("hands values only over this machine's owner-only socket", async () => {
    const node = await startNode()
    const answer = vi.fn(async () => Promise.resolve({ token: 'minted' }))
    const control = controlPlane(node.socket, new Map(), [], { answer, local: false })
    await control.client.start()
    await welcomed(control.client)
    const ask = async (type: 'secret.mint' | 'session.opening') =>
      node.service.control.ask(
        AGENT,
        type,
        type === 'secret.mint' ? { kind: 'connector' } : {},
        new AbortController().signal,
      )
    await expect(ask('secret.mint')).rejects.toThrow(/cross only to a node on this machine/)
    expect(answer).not.toHaveBeenCalled()
    await expect(ask('session.opening')).resolves.toEqual({ token: 'minted' })
    await expect(control.client.command('aws.token', { agent: AGENT })).rejects.toThrow(/cross only from a node/)
  })

  it('has a request that needs a value wait through a control plane restart, for a bounded time', async () => {
    const node = await startNode()
    reachControl(node.service.control)
    const first = controlPlane(node.socket, new Map(), [])
    await first.client.start()
    await welcomed(first.client)
    first.client.close()
    await expect(askValue(AGENT, 'secret.mint', { kind: 'connector' }, 100)).rejects.toBeInstanceOf(ValueLate)
    const waiting = askValue(AGENT, 'secret.mint', { kind: 'connector' }, 10_000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const answer = vi.fn(async () => Promise.resolve({ token: 'minted' }))
    const taking = vi.fn(async (_hello: HelloFrame) => Promise.resolve())
    const second = controlPlane(node.socket, new Map(), [], { answer, taking })
    await second.client.start()
    await expect(waiting).resolves.toEqual({ token: 'minted' })
    expect(answer).toHaveBeenCalledTimes(1)
    expect(taking.mock.calls[0]?.[0].asks).toHaveLength(1)
  })

  it('never names a value in an error or a log on either end', async () => {
    const value = ['value', 'that', 'never', 'shows'].join('-')
    const fail = async () => Promise.reject(new Error(`failed with ${value}`))
    const answers = Object.fromEntries(
      Object.keys(NODE_ASKS).map((type) => [type, fail]),
    ) as unknown as ControlEnd['answer']
    serveNode({
      journal: async () => Promise.resolve(),
      answer: {
        ...answers,
        'connection.value': async () => Promise.resolve({ value: { wrapped: value } as unknown as string }),
        'ssh.keys': async () => Promise.resolve({ keys: [value] }),
      },
    })
    const logged = vi.spyOn(process.stderr, 'write')
    const node = await startNode()
    reachControl(node.service.control)
    const control = controlPlane(node.socket, new Map(), [], { answer: nodeLink.answer })
    await control.client.start()
    await welcomed(control.client)
    const failures = await Promise.all([
      nodeLink.ask(AGENT, 'secret.mint', { kind: 'connector' }).catch((e: unknown) => e),
      nodeLink.ask(AGENT, 'connection.value', { connection: 'c', refused: value }).catch((e: unknown) => e),
    ])
    expect(failures.map(String)).toEqual([
      'Error: The control plane could not answer secret.mint',
      'Error: The control plane could not answer connection.value',
    ])
    await expect(nodeLink.ask(AGENT, 'ssh.keys', {})).resolves.toEqual({ keys: [value] })
    const raw = new WebSocket(`ws+unix://${node.socket}:/`)
    await new Promise((resolve) => raw.once('open', resolve))
    raw.send(JSON.stringify({ type: 'ask.answer', id: 'not-an-id', answer: { token: value } }))
    raw.close()
    await vi.waitFor(() => {
      expect(logged.mock.calls.flat().join('')).toContain('does not fit the protocol')
    })
    expect(logged.mock.calls.flat().join('')).not.toContain(value)
    logged.mockRestore()
  })
})
