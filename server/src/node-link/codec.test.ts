import {
  decodeNodeMessage,
  NODE_PROTOCOL_RANGE,
  NODE_PROTOCOL_VERSION,
  negotiateProtocol,
  type NodeMessage,
} from '@seti/shared'
import { describe, expect, it } from 'vitest'

const cursor = { epoch: 'e1', seq: 4 }
const entries = [
  { seq: 5, at: 1_700_000_000_000, type: 'turn.started', body: { turn: 1 } },
  { seq: 6, at: 1_700_000_000_001, type: 'sdk', body: ['any', 'shape'] },
]

const EVERY_MESSAGE: NodeMessage[] = [
  {
    v: 1,
    type: 'hello',
    id: 'h1',
    node: 'node-a',
    boot: 'boot-1',
    protocol: { min: 1, max: 2 },
    features: ['bulk'],
    clock: 1_700_000_000_000,
    sessions: { 'agent-1': { open: true } },
  },
  { v: 1, type: 'welcome', id: 'w1', version: 1, features: ['bulk'], cursors: { 'agent-1': cursor } },
  { v: 1, type: 'ping', id: 'p1' },
  { v: 1, type: 'pong', id: 'p2' },
  { v: 1, type: 'bye', id: 'b1', reason: 'stopping' },
  { v: 1, type: 'journal.append', id: 'j1', agent: 'agent-1', epoch: 'e1', first: 5, entries },
  { v: 1, type: 'journal.ack', id: 'j2', agent: 'agent-1', epoch: 'e1', seq: 6 },
  { v: 1, type: 'journal.reject', id: 'j3', agent: 'agent-1', reason: 'gap', first: 9, cursor },
  { v: 1, type: 'command', id: 'prompt-17', kind: 'turn.send', agent: 'agent-1', body: { text: 'hi' } },
  { v: 1, type: 'command.result', id: 'prompt-17', ok: true, body: { accepted: true } },
  { v: 1, type: 'command.result', id: 'prompt-18', ok: false, error: 'no such session' },
  { v: 1, type: 'ask', id: 'a1', kind: 'permission.ask', agent: 'agent-1', body: { tool: 'Bash' } },
  { v: 1, type: 'ask.answer', id: 'a1', body: { allow: true } },
  { v: 1, type: 'ask.cancel', id: 'a2' },
  { v: 1, type: 'ask.abort', id: 'a3' },
  { v: 1, type: 'state', id: 's1', agent: 'agent-1', version: 3, body: { hosts: ['example.com'] } },
  { v: 1, type: 'state', id: 's2', version: 1, body: { drain: false } },
  { v: 1, type: 'request', id: 'r1', kind: 'files.list', agent: 'agent-1', body: { path: '.' } },
  { v: 1, type: 'response', id: 'r1', ok: true, body: ['a.txt'] },
  { v: 1, type: 'response', id: 'r2', ok: false, error: 'offline' },
]

describe('decodeNodeMessage', () => {
  it('reads back every message type it encodes', () => {
    for (const message of EVERY_MESSAGE) {
      expect(decodeNodeMessage(JSON.stringify(message))).toEqual({ kind: 'message', message })
    }
  })

  it('reads an unknown type as unsupported with its id', () => {
    const text = JSON.stringify({ v: 9, type: 'teleport', id: 'x1', to: 'mars' })
    expect(decodeNodeMessage(text)).toEqual({ kind: 'unsupported', type: 'teleport', id: 'x1' })
  })

  it('drops unknown fields, so a newer peer can add them', () => {
    const text = JSON.stringify({ v: 2, type: 'ping', id: 'p1', extra: { nested: true } })
    expect(decodeNodeMessage(text)).toEqual({ kind: 'message', message: { v: 2, type: 'ping', id: 'p1' } })
    const hello = { ...EVERY_MESSAGE[0], token: 'later' }
    const decoded = decodeNodeMessage(JSON.stringify(hello))
    expect(decoded.kind === 'message' && 'token' in decoded.message).toBe(false)
  })

  it('reports broken input as invalid without throwing', () => {
    const invalid = [
      '{not json',
      '[]',
      'null',
      JSON.stringify({ type: 'ping', id: 'p1' }),
      JSON.stringify({ v: 1, type: 'ping', id: '' }),
      JSON.stringify({ v: 1, type: 'journal.ack', id: 'j', agent: 'a', epoch: 'e', seq: -1 }),
      JSON.stringify({ v: 1, type: 'command.result', id: 'c', ok: false }),
      JSON.stringify({ v: 1, type: 'hello', id: 'h', node: 'n', boot: 'b', protocol: { min: 3, max: 2 } }),
      JSON.stringify({ ...EVERY_MESSAGE[5], first: 4 }),
      JSON.stringify({ ...EVERY_MESSAGE[5], entries: [] }),
    ]
    for (const text of invalid) {
      expect(decodeNodeMessage(text).kind).toBe('invalid')
    }
  })
})

describe('negotiateProtocol', () => {
  const offer = (min: number, max: number, features: string[] = []) => ({ protocol: { min, max }, features })

  it('speaks the current and the previous version', () => {
    expect(NODE_PROTOCOL_RANGE.max).toBe(NODE_PROTOCOL_VERSION)
    expect(NODE_PROTOCOL_RANGE.min).toBe(Math.max(1, NODE_PROTOCOL_VERSION - 1))
  })

  it('agrees on the same version and the features both list', () => {
    expect(negotiateProtocol(offer(1, 1, ['a', 'b']), offer(1, 1, ['b', 'c']))).toEqual({
      kind: 'agreed',
      version: 1,
      features: ['b'],
    })
  })

  it('picks the highest version in an overlap', () => {
    expect(negotiateProtocol(offer(2, 4), offer(1, 3))).toMatchObject({ kind: 'agreed', version: 3 })
  })

  it('falls back to the previous version for an older peer', () => {
    expect(negotiateProtocol(offer(4, 5), offer(3, 4))).toMatchObject({ kind: 'agreed', version: 4 })
    expect(negotiateProtocol(offer(3, 4), offer(4, 5))).toMatchObject({ kind: 'agreed', version: 4 })
  })

  it('reports no common version as incompatible', () => {
    expect(negotiateProtocol(offer(5, 6), offer(3, 4))).toEqual({ kind: 'incompatible' })
    expect(negotiateProtocol(offer(1, 2), offer(3, 3))).toEqual({ kind: 'incompatible' })
  })
})
