import { describe, expect, it } from 'vitest'
import { inputChunks, parseServerMessage, resizeSince, resumes, retryDelay, terminalUrl } from './terminal-protocol'

describe('terminalUrl', () => {
  it('uses wss behind https and ws on a local http page, with the size, agent and resume in the query', () => {
    const agent = { id: 'a b', taskId: 't 1', resume: true, since: null }
    expect(terminalUrl({ protocol: 'https:', host: 'seti.example.com' }, agent, { cols: 80, rows: 24 })).toBe(
      'wss://seti.example.com/api/terminals/a%20b?cols=80&rows=24&task=t+1&resume=1',
    )
    const home = { id: 'h1', taskId: null, resume: false, since: null }
    expect(terminalUrl({ protocol: 'http:', host: 'localhost:3006' }, home, { cols: 120, rows: 40 })).toBe(
      'ws://localhost:3006/api/terminals/h1?cols=120&rows=40',
    )
  })
})

describe('resumes', () => {
  const shell = '9f0c1d8e-0000-4000-8000-000000000001'
  it('keeps the screen only when the same shell picks up at the byte the view reached', () => {
    expect(resumes({ shell, at: 120 }, { shell, from: 120 })).toBe(true)
    expect(resumes({ shell, at: 120 }, { shell, from: 0 })).toBe(false)
    expect(resumes({ shell, at: 120 }, { shell: 'other', from: 120 })).toBe(false)
    expect(resumes(null, { shell, from: 0 })).toBe(false)
  })

  it('asks for the rest of the shell it showed in the address', () => {
    const target = { id: 'h1', taskId: null, resume: true, since: { shell, at: 42 } }
    expect(terminalUrl({ protocol: 'http:', host: 'h' }, target, { cols: 80, rows: 24 })).toBe(
      `ws://h/api/terminals/h1?cols=80&rows=24&resume=1&shell=${shell}&at=42`,
    )
  })
})

describe('inputChunks', () => {
  it('splits long input at the limit without breaking a surrogate pair', () => {
    expect(inputChunks('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
    expect(inputChunks('ab\u{1F600}cd', 3)).toEqual(['ab', '\u{1F600}c', 'd'])
    expect(inputChunks('')).toEqual([])
  })
})

describe('retryDelay', () => {
  it('backs off and gives up within a minute', () => {
    const delays = Array.from({ length: 8 }, (_, attempt) => retryDelay(attempt))
    expect(delays.at(-1)).toBeNull()
    const total = delays.reduce<number>((sum, delay) => sum + (delay ?? 0), 0)
    expect(total).toBeLessThan(60_000)
  })
})

describe('parseServerMessage', () => {
  it('reads ready and closed frames and ignores anything else', () => {
    const shell = '9f0c1d8e-0000-4000-8000-000000000001'
    const ready = `{"type":"ready","reattached":true,"shell":"${shell}","from":7,"sandboxed":false,"cwd":"/w"}`
    expect(parseServerMessage(ready)).toEqual({
      type: 'ready',
      reattached: true,
      shell,
      from: 7,
      sandboxed: false,
      cwd: '/w',
    })
    expect(parseServerMessage('{"type":"closed","reason":"stopped","exit_code":null,"detail":"x"}')).toMatchObject({
      reason: 'stopped',
    })
    expect(parseServerMessage('{"type":"other"}')).toBeNull()
    expect(parseServerMessage('not json')).toBeNull()
  })
})

describe('resizeSince', () => {
  it('sends the size a fit gave the terminal while its socket connected, and nothing when it kept it', () => {
    expect(resizeSince({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBeNull()
    expect(resizeSince({ cols: 80, rows: 24 }, { cols: 132, rows: 51 })).toEqual({
      type: 'resize',
      cols: 132,
      rows: 51,
    })
    expect(resizeSince({ cols: 80, rows: 24 }, { cols: 80, rows: 40 })).toEqual({ type: 'resize', cols: 80, rows: 40 })
  })
})
