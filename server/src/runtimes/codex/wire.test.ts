import { describe, expect, it } from 'vitest'
import { WIRE_TEXT_LIMIT } from '../../wire-text.js'
import { wireCodex } from './wire.js'

const completed = (output: string) => ({
  root: 'thread-1',
  message: {
    method: 'item/completed',
    params: { threadId: 'thread-1', item: { type: 'commandExecution', id: 'call_9', aggregatedOutput: output } },
  },
})

describe('a Codex message on the wire', () => {
  it('keeps a short message as stored', () => {
    const payload = completed('ok')
    expect(wireCodex(payload)).toEqual({ value: payload, cut: [] })
  })

  it('cuts long output and names the call that lost text', () => {
    const { value, cut } = wireCodex(completed('x'.repeat(WIRE_TEXT_LIMIT * 2)))
    expect(cut).toEqual(['call_9'])
    expect(JSON.stringify(value).length).toBeLessThan(WIRE_TEXT_LIMIT * 2)
    expect(JSON.stringify(value)).toContain('trimmed for display')
  })
})
