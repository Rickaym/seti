import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OutputFrames } from './terminal-io.js'

describe('OutputFrames', () => {
  let sent: string[]
  let frames: OutputFrames
  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
    frames = new OutputFrames((data) => sent.push(data.toString()), 6, 8)
  })
  afterEach(() => {
    frames.clear()
    vi.useRealTimers()
  })

  it('sends the first chunk after a quiet spell at once, so typing echoes without delay', () => {
    frames.add(Buffer.from('a'))
    expect(sent).toEqual(['a'])
    vi.advanceTimersByTime(10)
    frames.add(Buffer.from('b'))
    expect(sent).toEqual(['a', 'b'])
  })

  it('gathers chunks that follow within the window into one frame', () => {
    frames.add(Buffer.from('1'))
    frames.add(Buffer.from('2'))
    frames.add(Buffer.from('3'))
    expect(sent).toEqual(['1'])
    vi.advanceTimersByTime(6)
    expect(sent).toEqual(['1', '23'])
    frames.add(Buffer.from('4'))
    expect(sent, 'a frame just went out, so the window is still open').toEqual(['1', '23'])
    vi.advanceTimersByTime(6)
    expect(sent).toEqual(['1', '23', '4'])
    vi.advanceTimersByTime(6)
    frames.add(Buffer.from('5'))
    expect(sent).toEqual(['1', '23', '4', '5'])
  })

  it('sends a frame early once it reaches the size cap', () => {
    frames.add(Buffer.from('x'))
    frames.add(Buffer.from('abcd'))
    frames.add(Buffer.from('efgh'))
    expect(sent).toEqual(['x', 'abcdefgh'])
    frames.add(Buffer.from('i'))
    vi.advanceTimersByTime(6)
    expect(sent).toEqual(['x', 'abcdefgh', 'i'])
  })

  it('sends what waits on flush, as the shell ends', () => {
    frames.add(Buffer.from('a'))
    frames.add(Buffer.from('bye'))
    frames.flush()
    expect(sent).toEqual(['a', 'bye'])
    frames.flush()
    expect(sent).toEqual(['a', 'bye'])
  })

  it('drops what waits on clear and sends the next chunk at once', () => {
    frames.add(Buffer.from('a'))
    frames.add(Buffer.from('b'))
    frames.clear()
    vi.advanceTimersByTime(20)
    expect(sent).toEqual(['a'])
    frames.add(Buffer.from('c'))
    expect(sent).toEqual(['a', 'c'])
  })
})
